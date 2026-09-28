import { Effect } from "effect";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LAMBDA_AST, analyzeChangeSetSemantics, collectGitChangeSet, type ChangeKind, type SemanticBeforeState, type SemanticDeclarationAmbiguity, type SemanticFileProfile } from "@openarch/core";
import { LiveLayer, printAnalysisError } from "./runtime";
import { type Locale, message } from "./i18n";

export type ChangeOverrides = ReadonlyMap<string, ChangeKind>;
export interface SemanticProfileSnapshot {
  readonly profiles: readonly SemanticFileProfile[];
  readonly afterTexts: ReadonlyMap<string, string>;
  readonly beforeStates: ReadonlyMap<string, SemanticBeforeState>;
}

const normalizePath = (path: string): string => path.replace(/\\/g, "/");

const CHANGE_KIND_ALIASES: Readonly<Record<string, ChangeKind>> = {
  interface_add: "interface_add_remove",
  interface_remove: "interface_add_remove",
  class_add: "class_add_remove",
  class_remove: "class_add_remove",
  field_add: "field_add_remove",
  field_remove: "field_add_remove",
};

const KIND_HINT = (): string =>
  `合法值: ${Object.keys(LAMBDA_AST).join(", ")}；简写别名: class_add/class_remove、interface_add/interface_remove、field_add/field_remove。`;

interface MissingOverride {
  readonly path: string;
  readonly reason: string;
  /**
   * 可执行的冲突事实（声明身份歧义时）：冲突声明 id、竞争签名与建议类别。
   * 单独携带而不是塞进 reason，是为了让消息构建器能排版，而不是让 Agent 解析长句。
   */
  readonly detail?: SemanticDeclarationAmbiguity;
}

const canonicalChangeKind = (kind: string): ChangeKind | undefined => {
  const canonical = CHANGE_KIND_ALIASES[kind] ?? kind;
  return canonical in LAMBDA_AST ? canonical as ChangeKind : undefined;
};

export const missingOverridesMessage = (source: SemanticProfileSource, missing: readonly MissingOverride[]): string => {
  const command = [
    "openarch check",
    source === "staged" ? "--staged" : "--worktree",
    ...missing.map(({ path }) => `--change-override \"${path}=<actual-kind>\"`),
    "--report",
  ].join(" ");
  return [
    `自动语义分析需要人工确认：${missing.length} 个文件尚无稳定分类。`,
    ...missing.flatMap(({ path, reason, detail }) => [
      `- ${path}: ${reason}`,
      ...(detail
        ? [
          `  冲突声明: ${detail.id}；竞争签名: ${detail.signatures.join(" | ")}；建议类型: ${detail.suggestedKind}`,
          `  可执行兜底: --change-override "${path}=${detail.suggestedKind}"`,
        ]
        : []),
    ]),
    `一次性补全后重试: ${command}`,
    `可用类型: ${Object.keys(LAMBDA_AST).join(", ")}；简写别名: class_add/class_remove、interface_add/interface_remove、field_add/field_remove。`,
  ].join("\n");
};

/**
 * 合并两种 override 来源：重复的 `--change-override <path>=<kind>` 与
 * `--change-override-file <json>`（`{"path": "kind"}` 或 `[{"path": "...", "kind": "..."}]`）。
 * 命令行参数最后写入，因此显式 flag 覆盖文件里的同路径条目。
 * 任何非法输入都 fail-closed（返回 undefined），与单个 flag 的非法处理一致。
 */
export const parseChangeOverrides = (args: readonly string[]): ChangeOverrides | undefined => {
  const overrides = new Map<string, ChangeKind>();
  const fileIndex = args.indexOf("--change-override-file");
  if (fileIndex >= 0) {
    const file = args[fileIndex + 1];
    if (!file) {
      console.error(`非法 --change-override-file: (missing)。格式: --change-override-file <json文件>，内容为 {"<path>": "<kind>"} 或 [{"path": "<path>", "kind": "<kind>"}]。`);
      return undefined;
    }
    const fromFile = readOverrideFile(file);
    if (!fromFile) return undefined;
    for (const [path, kind] of fromFile) overrides.set(path, kind);
  }
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--change-override") continue;
    const value = args[++index];
    const separator = value?.lastIndexOf("=") ?? -1;
    const path = separator > 0 ? value!.slice(0, separator) : "";
    const requestedKind = separator > 0 ? value!.slice(separator + 1) : "";
    const kind = canonicalChangeKind(requestedKind);
    if (!path || !kind) {
      console.error(`非法 --change-override: ${value ?? "(missing)"}。格式: <path>=<kind>；${KIND_HINT()}`);
      return undefined;
    }
    overrides.set(normalizePath(path), kind);
  }
  return overrides;
};

const parseOverrideEntry = (path: string, requestedKind: unknown): ChangeKind | undefined =>
  typeof path === "string" && path.length > 0 && typeof requestedKind === "string"
    ? canonicalChangeKind(requestedKind)
    : undefined;

const readOverrideFile = (file: string): ChangeOverrides | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    console.error(`非法 --change-override-file ${file}: ${error instanceof Error ? error.message : String(error)}。`);
    return undefined;
  }
  const entries: readonly [string, unknown][] = Array.isArray(parsed)
    ? parsed.flatMap((entry) => {
      const record = entry as { readonly path?: unknown; readonly kind?: unknown } | null;
      return record && typeof record.path === "string" ? [[record.path, record.kind] as const] : [];
    })
    : parsed !== null && typeof parsed === "object"
      ? Object.entries(parsed as Record<string, unknown>)
      : [];
  if (entries.length === 0) {
    console.error(`非法 --change-override-file ${file}: 需要一个非空对象 {"<path>": "<kind>"} 或数组 [{"path": "...", "kind": "..."}]；${KIND_HINT()}`);
    return undefined;
  }
  const overrides = new Map<string, ChangeKind>();
  for (const [path, requestedKind] of entries) {
    const kind = parseOverrideEntry(path, requestedKind);
    if (!kind) {
      console.error(`非法 --change-override-file 条目 ${file}: ${path}=${String(requestedKind)}。${KIND_HINT()}`);
      return undefined;
    }
    overrides.set(normalizePath(path), kind);
  }
  return overrides;
};

type SemanticProfileSource = "worktree" | "staged";

const analyzeProfiles = (cwd: string, paths: readonly string[], source: SemanticProfileSource) => {
  const changeSet = collectGitChangeSet(cwd, paths, { population: "change-evidence", source });
  return {
    analysis: Effect.runPromise(analyzeChangeSetSemantics(cwd, changeSet).pipe(Effect.provide(LiveLayer), Effect.either)),
    afterTexts: new Map(changeSet.files.flatMap((file) => file.afterText === undefined ? [] : [[file.path, file.afterText] as const])),
    beforeStates: new Map(changeSet.files.map((file) => [file.path, file.kind === "added" ? "introduced" : "unavailable"] as const)),
  };
};

const logProfiles = (snapshot: SemanticProfileSnapshot, locale: Locale, suffix = ""): SemanticProfileSnapshot => {
  const units = snapshot.profiles.reduce((total, profile) => total + profile.changes.length, 0);
  console.log(message(locale, "semantic.automatic", { suffix, files: snapshot.profiles.length, units }));
  return snapshot;
};

/**
 * 单文件重算 + 显式兜底。批处理已经自动分类成功且**未被标记不可用**的文件经 `preset`
 * 传入，不重复分析；只对失败文件（歧义/不可读）重算一次。
 *
 * override 账本：`consumed` 只统计**真正生效**的 override（被兜底写入的），
 * `ignored` 是指向本次 diff 内文件、却因为该文件自动分类成功而未被使用的 override——
 * 两者都必须回显，不再用 `overrides.size`（全部传入）冒充生效数量。
 */
const fallbackProfiles = async (
  cwd: string,
  paths: readonly string[],
  overrides: ChangeOverrides,
  source: SemanticProfileSource,
  locale: Locale,
  preset?: SemanticProfileSnapshot,
  failureReasons?: ReadonlyMap<string, MissingOverride>,
): Promise<SemanticProfileSnapshot | undefined> => {
  const usable = preset ? preset.profiles.filter((profile) => profile.unavailable !== true) : [];
  const reused = new Set(usable.map((profile) => profile.file));
  const attempted = preset ? paths.filter((path) => !reused.has(normalizePath(path))) : [...paths];
  const profiles: SemanticFileProfile[] = [...usable];
  const afterTexts = new Map<string, string>(preset ? preset.afterTexts : []);
  const beforeStates = new Map<string, SemanticBeforeState>(preset ? preset.beforeStates : []);
  const missing: MissingOverride[] = [];
  const consumed = new Map<string, ChangeKind>();
  for (const path of attempted) {
    const candidate = analyzeProfiles(cwd, [path], source);
    const analysis = await candidate.analysis;
    const normalized = normalizePath(path);
    const batch = failureReasons?.get(normalized);
    // 批处理失败与单文件重算一致（同源同解析）时，批处理携带的歧义细节更具体
    // （单文件报告只有 reason 字符串）；不一致时以单文件重算为准，绝不猜。
    const batchDetail = batch && batch.reason === (analysis._tag === "Right" ? analysis.right.reason : undefined)
      ? batch.detail
      : undefined;
    if (analysis._tag === "Right" && analysis.right.availability === "available" && !batchDetail) {
      profiles.push(...analysis.right.profiles);
      candidate.afterTexts.forEach((text, file) => afterTexts.set(file, text));
      candidate.beforeStates.forEach((state, file) => beforeStates.set(file, state));
      continue;
    }
    const reason = analysis._tag === "Left"
      ? "analysis failed"
      : analysis.right.reason ?? "semantic analysis unavailable";
    const kind = overrides.get(normalized) ?? overrides.get("all");
    if (!kind) {
      missing.push({ path, reason, ...(batchDetail ? { detail: batchDetail } : {}) });
      continue;
    }
    candidate.afterTexts.forEach((text, file) => afterTexts.set(file, text));
    const beforeState = candidate.beforeStates.get(normalized) ?? "unavailable";
    beforeStates.set(normalized, beforeState);
    const deleted = analysis._tag === "Right"
      && analysis.right.reason?.includes("deleted or unreadable after source")
      && !existsSync(resolve(cwd, path));
    profiles.push({ file: normalized, changes: [{ anchor: "manual:file", kind }], beforeState, ...(deleted ? { deleted: true } : {}) });
    consumed.set(normalized, kind);
    console.log(message(locale, "semantic.explicitFallback", { path, kind }));
  }
  if (missing.length > 0) {
    console.error(missingOverridesMessage(source, missing));
    return undefined;
  }
  return logProfiles(
    { profiles, afterTexts, beforeStates },
    locale,
    locale === "zh" ? `（含 ${consumed.size} 个显式兜底）` : ` (${consumed.size} explicit fallbacks)`,
  );
};

export interface AutomaticSemanticProfilesOutcome {
  readonly snapshot: SemanticProfileSnapshot;
  /** 实际被采纳的 override（`all` 也计入，且不展开为逐文件）。 */
  readonly appliedOverrides: ReadonlySet<string>;
  /** 指向本次 diff 内文件、但自动分类成功因而从未被使用的 override。 */
  readonly ignoredOverrides: readonly string[];
}

export const automaticSemanticProfiles = async (
  cwd: string,
  paths: readonly string[],
  overrides: ChangeOverrides,
  source: SemanticProfileSource = "worktree",
  locale: Locale = "zh",
): Promise<AutomaticSemanticProfilesOutcome | undefined> => {
  const candidate = analyzeProfiles(cwd, paths, source);
  const initial = await candidate.analysis;
  if (initial._tag === "Left") {
    printAnalysisError(initial.left);
    return undefined;
  }
  const requested = new Set(paths.map(normalizePath));
  // 指向本次 diff 之外文件的 override 永远无法生效：任何路径下都立即 fail closed。
  const unused = [...overrides.keys()].filter((key) => key !== "all" && !requested.has(key));
  if (unused.length > 0) {
    console.error(`--change-override 指向未参与本次 diff 的文件: ${unused.join(", ")}`);
    return undefined;
  }
  const ignored = (applied: ReadonlySet<string>): readonly string[] =>
    [...overrides.keys()].filter((key) => key !== "all" && !applied.has(key));
  if (initial.right.availability === "available") {
    // 成功路径同样审计：没有任何 override 被消费时，明确说明它们被忽略。
    const snapshot = logProfiles({ profiles: initial.right.profiles, afterTexts: candidate.afterTexts, beforeStates: candidate.beforeStates }, locale);
    const ignoredOverrides = ignored(new Set());
    if (ignoredOverrides.length > 0) {
      console.error(`--change-override 未被使用（这些文件已自动分类成功，override 被忽略）: ${ignoredOverrides.join(", ")}`);
    }
    return { snapshot, appliedOverrides: new Set(), ignoredOverrides };
  }
  // 部分可用（一个歧义文件不再毒化整批）：成功文件直接采纳，只对失败文件重算。
  const partial = initial.right.availability === "partial";
  const preset = partial
    ? {
      profiles: initial.right.profiles,
      afterTexts: candidate.afterTexts,
      beforeStates: candidate.beforeStates,
    } satisfies SemanticProfileSnapshot
    : undefined;
  const failureReasons = new Map<string, MissingOverride>(
    (partial ? initial.right.failures : []).map((failure) => [
      normalizePath(failure.path),
      { path: failure.path, reason: failure.reason, ...(failure.ambiguity ? { detail: failure.ambiguity } : {}) },
    ]),
  );
  const retryPaths = partial
    ? initial.right.failures.map((failure) => failure.path)
    : paths;
  const snapshot = await fallbackProfiles(cwd, retryPaths, overrides, source, locale, preset, failureReasons);
  if (!snapshot) return undefined;
  const applied = new Set<string>();
  for (const profile of snapshot.profiles) {
    if (profile.changes.some((change) => change.anchor === "manual:file")) applied.add(profile.file);
  }
  const allUsed = [...overrides.keys()].some((key) => key === "all") && snapshot.profiles.some((profile) => profile.changes.some((change) => change.anchor === "manual:file"));
  return {
    snapshot,
    appliedOverrides: allUsed ? new Set([...applied, "all"]) : applied,
    ignoredOverrides: ignored(applied),
  };
};
