// packages/core/src/application/discover.ts
// discover 用例：执行规则 mjs → 发现隐式依赖边 → 按 source 合并写回 implicit-deps.yml。
// design TD-17 Phase A。
import { Effect } from "effect";
import { resolve } from "node:path";
import { execFileHidden } from "../infra/childProcess";
import { ParserService } from "../port/ParserService";
import { isAnalyzableProjectFile, listProjectSourceFiles, resolveProjectExtensions } from "../projectFiles";
import { globSync } from "../infra/glob";

import { implicitDepsRulesDir, toPosixPath } from "../infra/paths";
import { executeRule } from "../implicit-deps/engine";
import { readImplicitDepsYml, mergeBySource, writeImplicitDepsYml } from "../implicit-deps/merge";
import type { DiscoveredEdge, DiscoveredObservation, StoredEdge } from "../implicit-deps/types";
import { loadScriptFacts } from "./scriptFacts";
import { requestedScriptCapabilities } from "../script-runtime/scriptRequirements";
import { withGovernanceWriteLock } from "./governance/writeLock";
import { collectGitChangeSet } from "./changeSet";
import { analyzeChangeSetSemantics } from "./semanticDiff";
import type { ChangeSurfaceContainer, ChangeSurfaceFact, ChangeSurfaceFileChange, ChangeSurfaceHunk, ChangeSurfaceSymbolFact, FactResult } from "../script-runtime/projectFacts";
import { implicitDependencyAdapterFor } from "../script-runtime/implicitDependencyAdapters";


export interface DiscoverInput {
  /** 显式指定的规则 mjs 路径（覆盖默认 glob） */
  readonly rules?: readonly string[];
  /** 候选文件 glob（默认按项目已配置语言扫描生产源码） */
  readonly fileGlob?: string;
  /**
   * 变更模式（change-surface.v1 接通，2026-08-07）：从 git diff 构造变更集，
   * 脚本执行聚焦变更文件，facts.changeSurface 提供 changedSymbols（变更的声明）。
   * 非变更模式（默认）changeSurface fact 为 unavailable（诚实）。
   */
  readonly source?: "staged" | "worktree";
}

export interface DiscoverReport {
  readonly rulesRun: number;
  /** 本轮规则识别到的关系数；并不等于首次写入。 */
  readonly edgesFound: number;
  readonly edgesAdded: number;
  readonly edgesRemoved: number;
  readonly totalEdges: number;
  readonly errors: readonly string[];
  /** 脚本执行与观测的有名分区（report-surface 预算内）。 */
  readonly evidence: {
    /** 规则的 report-only 观测（未解析键/动态键/说明）；不落边、不进 gate。 */
    readonly observations: readonly (DiscoveredObservation & { readonly source: string })[];
    readonly pruning: readonly {
      readonly source: string;
      readonly inputFiles: number;
      readonly targetFiles: number;
      readonly candidateFiles: number;
      readonly records: number;
    }[];
  };
}

const edgeKey = (edge: Pick<DiscoveredEdge, "from" | "to" | "via" | "type">): string =>
  `${edge.from}\0${edge.to}\0${edge.via}\0${edge.type}`;

const defaultFiles = (): string[] => {
  try {
    return [...listProjectSourceFiles({ population: "production-governance" })];
  } catch {
    return [];
  }
};

/** 默认规则集：.openarch/implicit-deps/rules/*.mjs */
const defaultRules = (): string[] => {
  try {
    return globSync("*.mjs", { cwd: implicitDepsRulesDir() }).map((f: string) => `${implicitDepsRulesDir()}/${f}`);
  } catch {
    return [];
  }
};

/** git diff --unified=0 的 hunk 解析（变更行片段 + before/after 起始行，
 * 2026-08-07——文件内具体变更部分，变更时隐式依赖分析的输入）。 */
const gitDiffHunks = (cwd: string, source: "staged" | "worktree"): ReadonlyMap<string, readonly ChangeSurfaceHunk[]> => {
  const args = ["diff", "--unified=0", ...(source === "staged" ? ["--cached"] : []), "--relative", "-z", "HEAD"];
  let raw = "";
  try {
    raw = execFileHidden("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
  } catch {
    return new Map();
  }
  const hunksByFile = new Map<string, ChangeSurfaceHunk[]>();
  let currentFile: string | undefined;
  let beforeStart = 0;
  let afterStart = 0;
  const beforeLines: string[] = [];
  const afterLines: string[] = [];
  const flush = (): void => {
    if (!currentFile) return;
    if (beforeLines.length === 0 && afterLines.length === 0) return;
    const existing = hunksByFile.get(currentFile) ?? [];
    existing.push({ before: [...beforeLines], after: [...afterLines], beforeStartLine: beforeStart, afterStartLine: afterStart });
    hunksByFile.set(currentFile, existing);
  };
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      flush();
      beforeLines.length = 0; afterLines.length = 0;
      currentFile = undefined; beforeStart = 0; afterStart = 0;
      continue;
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      flush();
      beforeLines.length = 0; afterLines.length = 0;
      beforeStart = Number(header[1]); afterStart = Number(header[2]);
      continue;
    }
    if (line.startsWith("+++ b/") || line.startsWith("--- a/")) {
      if (line.startsWith("+++ b/")) currentFile = line.slice(6);
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("--- ")) { beforeLines.push(line.slice(1)); continue; }
    if (line.startsWith("+") && !line.startsWith("+++ ")) { afterLines.push(line.slice(1)); continue; }
  }
  flush();
  return hunksByFile;
};

interface DeclContainer { readonly name: string; readonly kind: "class" | "method" | "function"; readonly startLine: number; readonly endLine: number; }

const languageOfFile = (file: string): string => {
  const ext = file.split(".").at(-1) ?? "";
  switch (ext) {
    case "ts": case "tsx": return "typescript";
    case "js": case "jsx": case "mjs": case "cjs": return "javascript";
    case "py": return "python";
    case "go": return "go";
    case "rs": return "rust";
    case "java": return "java";
    default: return ext;
  }
};

/** 容器查询经语言适配器分发（script-runtime/implicitDependencyAdapters.ts——
 * 多语言入口：TS/JS/Java/Python/Go/Rust 各提供容器模式，未知语言降级）。 */
const containersForFile = (parser: ParserService, absolutePath: string): readonly DeclContainer[] => {
  const adapter = implicitDependencyAdapterFor(languageOfFile(absolutePath));
  const pattern = adapter?.containerQuery;
  if (!pattern) return [];
  const result = Effect.runSync(parser.query(absolutePath, pattern).pipe(Effect.either));
  if (result._tag === "Left") return [];
  return result.right.flatMap((match) => {
    const kindCapture = match.captures.find((c) => c.name === "class" || c.name === "method" || c.name === "function");
    const nameCapture = match.captures.find((c) => c.name === "name");
    if (!kindCapture?.startLine || !kindCapture.endLine || !nameCapture) return [];
    return [{ name: nameCapture.text, kind: kindCapture.name as "class" | "method" | "function", startLine: kindCapture.startLine, endLine: kindCapture.endLine }];
  });
};

const smallestContainerFor = (containers: readonly DeclContainer[], line: number): ChangeSurfaceContainer | undefined => {
  const enclosing = containers
    .filter((container) => container.startLine <= line && line <= container.endLine)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine));
  const smallest = enclosing[0];
  return smallest ? { name: smallest.name, kind: smallest.kind } : undefined;
};

/** 变更面事实（应用层约定校准 2026-08-07：被 Effect 应用复用的函数返回 Effect，
 *  命令式壳放命令层——本函数被 discoverUnlocked（Effect 世界）调用，以 Effect
 *  返回避免 async 壳 + 内部 runPromise 的双重世界穿越）。 */
export const changeSurfaceFactsFor = (cwd: string, source: "staged" | "worktree", parser: ParserService, input?: DiscoverInput): Effect.Effect<{ readonly files: string[]; readonly changeSurface?: FactResult<ChangeSurfaceFact> }> =>
  Effect.gen(function* () {
    const changeSet = collectGitChangeSet(cwd, [], { source });
    if (changeSet.availability !== "available" || changeSet.files.length === 0) {
      return { files: [], changeSurface: { availability: "unavailable", reason: changeSet.availability !== "available" ? (changeSet.reason ?? "Git change set is incomplete") : "no changes in the selected source" } };
    }
    // 过滤非分析文件（untracked 的规则 mjs/二进制等会让语义分析单文件失败毁整个
    // 变更集，校准 2026-08-07）——按 cwd 已配置语言的扩展名判断（isAnalyzableProjectFile
    // 用全局 projectRoot，不适用变更集上下文）；规则 mjs 本身排除
    const extensions = resolveProjectExtensions(cwd);
    const excludedRules = new Set((input?.rules ?? []).map((rule) => toPosixPath(rule)));
    const analyzable = changeSet.files.filter((file) =>
      extensions.some((ext) => file.path.toLowerCase().endsWith(ext))
      && !excludedRules.has(toPosixPath(file.path)),
    );
    if (analyzable.length === 0) {
      return { files: [], changeSurface: { availability: "unavailable", reason: "no analyzable changed files" } };
    }
    const report = yield* analyzeChangeSetSemantics(cwd, { ...changeSet, files: analyzable }).pipe(Effect.provideService(ParserService, parser));
    if (report.availability !== "available") {
      return { files: changeSet.files.map((file) => file.path), changeSurface: { availability: "unavailable", reason: report.reason } };
    }
    const changedSymbols: ChangeSurfaceSymbolFact[] = report.profiles.flatMap((profile) =>
      profile.changes
        .filter((change) => !change.anchor.startsWith("import:"))
        .map((change) => ({ file: toPosixPath(profile.file), anchor: change.anchor, kind: change.kind })),
    );
    // 文件内具体变更部分（hunk 级）——git diff --unified=0 的变更行片段；
    // 每个 hunk 附加语义容器（变更行所在的方法/函数/类——tree-sitter 查询，
    // 非 LSP：脚本引擎自身用于发现 LSP 看不到的隐式依赖，容器只是定位上下文）
    const hunksByFile = gitDiffHunks(cwd, source);
    const changes: ChangeSurfaceFileChange[] = [...hunksByFile.entries()].map(([file, hunks]) => {
      const normalized = toPosixPath(file);
      const containers = containersForFile(parser, resolve(cwd, normalized));
      return {
        file: normalized,
        language: languageOfFile(normalized),
        hunks: hunks.map((hunk) => ({ ...hunk, container: smallestContainerFor(containers, hunk.afterStartLine) })),
      };
    });
    return {
      files: [...new Set(report.profiles.map((profile) => toPosixPath(profile.file)))],
      changeSurface: changedSymbols.length > 0
        ? { availability: "available", value: { schemaVersion: 2, languages: [...new Set(report.profiles.map((profile) => profile.file))], changedSymbols, changes } }
        : { availability: "unavailable", reason: "no changed declarations detected" },
    };
  });

const discoverUnlocked = (input: DiscoverInput, parser: ParserService) => Effect.gen(function* () {
    const changeContext = input.source
      ? yield* changeSurfaceFactsFor(process.cwd(), input.source!, parser, input)
      : undefined;
    // 脚本主线语义不变：变更模式下 files 仍是变更文件（默认聚焦）。
    // 变更面是补充事实——需要全量候选的脚本（消费者模式等）经 text 阶段的
    // ctx.allFiles 显式取全量（校准 2026-08-07），不改变其他脚本的输入。
    const files = changeContext
      ? changeContext.files
      : input.fileGlob
        ? globSync(input.fileGlob, { exclude: (f: string) => f.includes("node_modules") || f.includes("/dist/") })
          .filter((file) => isAnalyzableProjectFile(file, { population: "production-governance" }))
        : defaultFiles();
    const allFiles = input.fileGlob
      ? globSync(input.fileGlob, { exclude: (f: string) => f.includes("node_modules") || f.includes("/dist/") })
        .filter((file) => isAnalyzableProjectFile(file, { population: "production-governance" }))
      : defaultFiles();
    const rulePaths = input.rules && input.rules.length > 0 ? [...input.rules] : defaultRules();

    if (rulePaths.length === 0) {
      return { rulesRun: 0, edgesFound: 0, edgesAdded: 0, edgesRemoved: 0, totalEdges: readImplicitDepsYml().length, errors: ["无规则 mjs（放入 .openarch/implicit-deps/rules/ 或 --rule 指定）"], evidence: { observations: [], pruning: [] } };
    }
    if (files.length === 0) {
      return { rulesRun: 0, edgesFound: 0, edgesAdded: 0, edgesRemoved: 0, totalEdges: readImplicitDepsYml().length, errors: [changeContext?.changeSurface?.availability === "unavailable" ? `变更模式无变更文件: ${changeContext.changeSurface.reason}` : "无目标文件"], evidence: { observations: [], pruning: [] } };
    }

    const errors: string[] = [];
    const observations: (DiscoveredObservation & { readonly source: string })[] = [];
    const requestedCapabilities = yield* Effect.promise(() => requestedScriptCapabilities(rulePaths));
    const facts = yield* loadScriptFacts({ files, requestedCapabilities, ...(changeContext?.changeSurface ? { changeSurface: changeContext.changeSurface } : {}) });
    let existing: StoredEdge[] = readImplicitDepsYml();
    let edgesFound = 0;
    let edgesAdded = 0;
    let edgesRemoved = 0;
    const pruning: DiscoverReport["evidence"]["pruning"][number][] = [];

    for (const rulePath of rulePaths) {
      const source = rulePath.replace(/^.*[\\/]/, "");   // 文件名作 source（如 ts-eventbus.mjs）
      const { edges, observations: ruleObservations, error, unavailable, stages } = yield* Effect.promise(() => executeRule(rulePath, files, parser, undefined, { facts, allFiles }));
      if (error) errors.push(error);
      if (unavailable) errors.push(`${source}: ${unavailable}`);
      observations.push(...ruleObservations.map((observation) => ({ ...observation, source })));
      if (stages) {
        pruning.push({
          source,
          inputFiles: stages.inputFiles,
          targetFiles: stages.targetFiles.length,
          candidateFiles: stages.candidateFiles.length,
          records: stages.records.length,
        });
      }
      if (edges.length > 0) {
        const previousForSource = existing.filter((edge) => edge.source === source);
        const previousKeys = new Set(previousForSource.map(edgeKey));
        const currentKeys = new Set(edges.map(edgeKey));
        edgesAdded += edges.filter((edge) => !previousKeys.has(edgeKey(edge))).length;
        edgesRemoved += previousForSource.filter((edge) => !currentKeys.has(edgeKey(edge))).length;
        existing = mergeBySource(existing, edges, source);
        edgesFound += edges.length;
      } else {
        edgesRemoved += existing.filter((edge) => edge.source === source).length;
        existing = mergeBySource(existing, edges, source);
      }
    }

    if (errors.length > 0) {
      return {
        rulesRun: rulePaths.length,
        edgesFound,
        edgesAdded: 0,
        edgesRemoved: 0,
        totalEdges: existing.length,
        errors,
        evidence: { observations, pruning },
      } as DiscoverReport;
    }
    yield* Effect.promise(() => writeImplicitDepsYml(existing));

    return {
      rulesRun: rulePaths.length,
      edgesFound,
      totalEdges: existing.length,
      edgesAdded,
      edgesRemoved,
      errors,
      evidence: { observations, pruning },
    } as DiscoverReport;
  });

export const discover = (input: DiscoverInput = {}) =>
  Effect.gen(function* () {
    const parser = yield* ParserService;
    return yield* withGovernanceWriteLock(
      process.env.OPENARCH_AGENT_ID ?? "discover",
      () => discoverUnlocked(input, parser),
    );
  });
