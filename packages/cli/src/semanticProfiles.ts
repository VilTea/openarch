import { Effect } from "effect";
import { LAMBDA_AST, analyzeChangeSetSemantics, collectGitChangeSet, type ChangeKind, type SemanticBeforeState, type SemanticFileProfile } from "@openarch/core";
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

interface MissingOverride {
  readonly path: string;
  readonly reason: string;
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
    ...missing.map(({ path, reason }) => `- ${path}: ${reason}`),
    `一次性补全后重试: ${command}`,
    `可用类型: ${Object.keys(LAMBDA_AST).join(", ")}；简写别名: class_add/class_remove、interface_add/interface_remove、field_add/field_remove。`,
  ].join("\n");
};

/** Explicit per-file fallback preserves automatic evidence for every analyzable sibling. */
export const parseChangeOverrides = (args: readonly string[]): ChangeOverrides | undefined => {
  const overrides = new Map<string, ChangeKind>();
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--change-override") continue;
    const value = args[++index];
    const separator = value?.lastIndexOf("=") ?? -1;
    const path = separator > 0 ? value!.slice(0, separator) : "";
    const requestedKind = separator > 0 ? value!.slice(separator + 1) : "";
    const kind = canonicalChangeKind(requestedKind);
    if (!path || !kind) {
      console.error(`非法 --change-override: ${value ?? "(missing)"}。格式: <path>=<kind>；合法值: ${Object.keys(LAMBDA_AST).join(", ")}；简写别名: class_add/class_remove、interface_add/interface_remove、field_add/field_remove。`);
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

const fallbackProfiles = async (cwd: string, paths: readonly string[], overrides: ChangeOverrides, source: SemanticProfileSource, locale: Locale): Promise<SemanticProfileSnapshot | undefined> => {
  const profiles: SemanticFileProfile[] = [];
  const afterTexts = new Map<string, string>();
  const beforeStates = new Map<string, SemanticBeforeState>();
  const missing: MissingOverride[] = [];
  for (const path of paths) {
    const candidate = analyzeProfiles(cwd, [path], source);
    const analysis = await candidate.analysis;
    if (analysis._tag === "Right" && analysis.right.availability === "available") {
      profiles.push(...analysis.right.profiles);
      candidate.afterTexts.forEach((text, file) => afterTexts.set(file, text));
      candidate.beforeStates.forEach((state, file) => beforeStates.set(file, state));
      continue;
    }
    const kind = overrides.get(normalizePath(path));
    if (!kind) {
      const reason = analysis._tag === "Left" ? "analysis failed" : analysis.right.reason ?? "semantic analysis unavailable";
      missing.push({ path, reason });
      continue;
    }
    candidate.afterTexts.forEach((text, file) => afterTexts.set(file, text));
    const normalized = normalizePath(path);
    const beforeState = candidate.beforeStates.get(normalized) ?? "unavailable";
    beforeStates.set(normalized, beforeState);
    profiles.push({ file: normalized, changes: [{ anchor: "manual:file", kind }], beforeState });
    console.log(message(locale, "semantic.explicitFallback", { path, kind }));
  }
  if (missing.length > 0) {
    console.error(missingOverridesMessage(source, missing));
    return undefined;
  }
  return logProfiles({ profiles, afterTexts, beforeStates }, locale, locale === "zh" ? `（含 ${overrides.size} 个显式兜底）` : ` (${overrides.size} explicit fallbacks)`);
};

export const automaticSemanticProfiles = async (
  cwd: string,
  paths: readonly string[],
  overrides: ChangeOverrides,
  source: SemanticProfileSource = "worktree",
  locale: Locale = "zh",
): Promise<SemanticProfileSnapshot | undefined> => {
  const candidate = analyzeProfiles(cwd, paths, source);
  const initial = await candidate.analysis;
  if (initial._tag === "Left") {
    printAnalysisError(initial.left);
    return undefined;
  }
  if (initial.right.availability === "available") return logProfiles({ profiles: initial.right.profiles, afterTexts: candidate.afterTexts, beforeStates: candidate.beforeStates }, locale);
  const requested = new Set(paths.map(normalizePath));
  const unused = [...overrides.keys()].filter((path) => !requested.has(path));
  if (unused.length > 0) {
    console.error(`--change-override 指向未参与本次 diff 的文件: ${unused.join(", ")}`);
    return undefined;
  }
  return fallbackProfiles(cwd, paths, overrides, source, locale);
};
