import { readFileSync } from "node:fs";
import { Effect } from "effect";
import type { QueryMatch, ParserService } from "../port/ParserService";
import { isStaticImportsAstStage, isStringKeyCallsAstStage, type QueryAstStage, type StringKeyCallsFact, type StageExecution, type StagedAnalysis, type StageRecord, type AstChangeContext } from "./types";
import { staticImportRecords } from "./staticImports";
import { STRING_KEY_CALLS_QUERY, stringKeyCallRecords, supportsStringKeyCalls } from "./stringKeyCalls";
import type { StagedRule } from "./types";
import { emptyProjectFacts, normalizeRepositoryPath, selectScriptTargetFiles, targetRequiredCapabilities, unavailableRequiredFact, withRuleLocalAuthority, type ProjectFacts } from "../script-runtime/projectFacts";

/** Change-time context for a single file: 1-based lines (after) touched by the
 *  diff, plus their semantic containers. Absent when change surface unavailable. */
const changeContextFor = (file: string, facts: ProjectFacts): AstChangeContext => {
  const surface = facts.changeSurface;
  if (surface?.availability !== "available" || !surface.value) return {};
  const fileChange = surface.value.changes.find((c) => c.file === file);
  if (!fileChange) return {};
  const changedLines = new Set<number>();
  for (const hunk of fileChange.hunks) {
    const start = hunk.afterStartLine;
    for (let i = 0; i < hunk.after.length; i++) changedLines.add(start + i);
  }
  return { changedLines, hunks: fileChange.hunks };
};

export const queryWithCache = (
  file: string,
  pattern: string,
  parser: ParserService,
  cache: Map<string, Promise<readonly QueryMatch[]>> | undefined,
): Promise<readonly QueryMatch[]> => {
  if (!cache) return Effect.runPromise(parser.query(file, pattern));
  const key = `${file}\0${pattern}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const query = Effect.runPromise(parser.query(file, pattern)).catch((error) => {
    // A transient parser failure must not poison the command-scoped cache for
    // later rules or retries; retain only successful facts.
    if (cache.get(key) === query) cache.delete(key);
    throw error;
  });
  cache.set(key, query);
  return query;
};

const staticImportRecordsFor = async (files: readonly string[], parser: ParserService): Promise<{ readonly records: readonly StageRecord[]; readonly unavailable?: string }> => {
  const records: StageRecord[] = [];
  for (const file of files) {
    try {
      const ast = await Effect.runPromise(parser.parse(file));
      records.push(...staticImportRecords(file, ast).map((record) => ({ ...record, _file: normalizeRepositoryPath(record._file) })));
    } catch (error) {
      return { records: [], unavailable: `static-imports.v1 unavailable for ${file}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { records };
};

const stringKeyRecordsFor = async (
  files: readonly string[],
  parser: ParserService,
  queryCache: Map<string, Promise<readonly QueryMatch[]>> | undefined,
  fact: StringKeyCallsFact,
): Promise<{ readonly records: readonly StageRecord[]; readonly unavailable?: string }> => {
  const records: StageRecord[] = [];
  for (const file of files) {
    if (!supportsStringKeyCalls(file)) {
      return { records: [], unavailable: `${fact} unavailable for ${file}: only TypeScript/JavaScript syntax is supported` };
    }
    let matches: readonly QueryMatch[];
    try {
      matches = await queryWithCache(file, STRING_KEY_CALLS_QUERY, parser, queryCache);
    } catch (error) {
      return { records: [], unavailable: `${fact} unavailable for ${file}: ${error instanceof Error ? error.message : String(error)}` };
    }
    records.push(...stringKeyCallRecords(matches).map((record) => ({ ...record, _file: normalizeRepositoryPath(file) })));
  }
  return { records };
};

const queryRecordsFor = async (
  files: readonly string[],
  stage: QueryAstStage,
  parser: ParserService,
  queryCache: Map<string, Promise<readonly QueryMatch[]>> | undefined,
  facts: ProjectFacts,
): Promise<{ readonly records: readonly StageRecord[]; readonly unavailable?: string }> => {
  const records: StageRecord[] = [];
  for (const file of files) {
    let matches: readonly QueryMatch[];
    try {
      matches = await queryWithCache(file, stage.pattern, parser, queryCache);
    } catch (error) {
      return { records: [], unavailable: `AST query unavailable for ${file}: ${error instanceof Error ? error.message : String(error)}` };
    }
    const extracted = stage.extract
      ? stage.extract(matches, file, changeContextFor(file, facts))
      : matches.map((match) => ({ captures: match.captures.map((capture) => capture.text) }));
    for (const record of extracted) records.push({ ...record, _file: normalizeRepositoryPath(file) });
  }
  return { records };
};

/** Runs the fixed text -> AST sequence; callers own only their final semantic link step. */
export interface StagedAnalysisExecution {
  readonly stages?: StageExecution;
  readonly unavailable?: string;
}

export const executeStagedAnalysis = async (
  stages: StagedAnalysis,
  files: readonly string[],
  parser: ParserService,
  queryCache?: Map<string, Promise<readonly QueryMatch[]>>,
  facts = emptyProjectFacts(),
  allFiles?: readonly string[],
): Promise<StagedAnalysisExecution> => {
  // 引擎路径边界：脚本只看到仓库相对路径（多人协作 checkout 位置不确定，
  // 绝对路径会让 records/落盘/缓存随机器漂移，校准 2026-08-07）。
  // text 阶段入参与 records._file 统一经 normalizeRepositoryPath。
  const normalizedFiles = files.map((file) => normalizeRepositoryPath(file));
  const normalizedAll = allFiles?.map((file) => normalizeRepositoryPath(file));
  const candidateFiles = stages.text
    ? stages.text({ files: normalizedFiles, allFiles: normalizedAll, text: (path) => readFileSync(path, "utf8"), facts })
    : [...normalizedFiles];

  const outcome = !stages.ast
    ? { records: candidateFiles.map((file) => ({ _file: normalizeRepositoryPath(file) })) as readonly StageRecord[] }
    : isStaticImportsAstStage(stages.ast)
      ? await staticImportRecordsFor(candidateFiles, parser)
      : isStringKeyCallsAstStage(stages.ast)
        ? await stringKeyRecordsFor(candidateFiles, parser, queryCache, stages.ast.fact)
        : await queryRecordsFor(candidateFiles, stages.ast, parser, queryCache, facts);
  if (outcome.unavailable) return { unavailable: outcome.unavailable };
  return { stages: { inputFiles: files.length, targetFiles: [...normalizedFiles], candidateFiles, records: outcome.records } };
};

export interface StagedScriptExecution<Result> {
  readonly output: readonly Result[];
  readonly stages?: StageExecution;
  readonly error?: string;
  readonly unavailable?: string;
}

/** Shared script boundary: every project-script domain uses the same facts and staged traversal. */
export const executeStagedScript = async <Result>(
  rule: StagedRule<Result>,
  files: readonly string[],
  parser: ParserService,
  options: {
    readonly facts?: ProjectFacts;
    readonly log: (...args: unknown[]) => void;
    readonly queryCache?: Map<string, Promise<readonly QueryMatch[]>>;
    readonly allFiles?: readonly string[];
  },
): Promise<StagedScriptExecution<Result>> => {
  const baseFacts = options.facts ?? emptyProjectFacts();
  const localAuthority = rule.authority ? withRuleLocalAuthority(baseFacts, rule.authority) : { facts: baseFacts };
  if (!localAuthority.facts) {
    return localAuthority.error
      ? { output: [], error: localAuthority.error }
      : { output: [], unavailable: localAuthority.unavailable };
  }
  const facts = localAuthority.facts;
  const required = [...new Set([
    ...(rule.requires ?? []),
    ...targetRequiredCapabilities(rule.targets),
    ...(rule.authority ? ["authorities.v1" as const] : []),
  ])];
  const unavailable = unavailableRequiredFact(required, facts);
  if (unavailable) return { output: [], unavailable };
  const selection = selectScriptTargetFiles(files, rule.targets, facts);
  if (selection.unavailable) return { output: [], unavailable: selection.unavailable };
  const analysis = await executeStagedAnalysis(rule.stages, selection.files, parser, options.queryCache, facts, options.allFiles);
  if (analysis.unavailable) return { output: [], unavailable: analysis.unavailable };
  const stages = { ...analysis.stages!, inputFiles: files.length };
  const output = await Promise.resolve(rule.link({ records: stages.records, log: options.log, facts }));
  return { output, stages };
};
