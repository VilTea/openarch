import { basename } from "node:path";
import type { QueryMatch, ParserService } from "../port/ParserService";
import { executeStagedScript } from "../staged-analysis/engine";
import { isStagedRuleContract, type StageExecution, type StageRecord, type StagedRule } from "../staged-analysis/types";
import { loadDefaultExport, type ScriptImport } from "../script-runtime/loadDefaultExport";
import type { ProjectFacts, ScriptAuthorityContract } from "../script-runtime/projectFacts";
import {
  executeChangeSetRule,
  isAntiPatternHitInput,
  isChangeSetRule,
  type AntiPatternHitInput,
  type ChangeSetContext,
  type ChangeSetRule,
} from "./changeSetExecution";

export type {
  AntiPatternCategory,
  AntiPatternHitInput,
  AntiPatternSeverity,
  ChangeSetAvailability,
  ChangeSetContext,
  ChangeSetFile,
  ChangeSetRule,
  ChangeSetRuleContext,
} from "./changeSetExecution";

export type AntiPatternScope = "file" | "repository" | "change_set";

/** @deprecated Import ScriptAuthorityContract from script-runtime/projectFacts for new runtime code. */
export type AuthorityContract = ScriptAuthorityContract;

export interface AntiPatternHit extends AntiPatternHitInput { readonly source: string; readonly scope: AntiPatternScope; }
export type AntiPatternRecord = StageRecord;

export type AntiPatternStagedRule = StagedRule<AntiPatternHitInput> & { readonly scope: "file" | "repository"; };
export type AntiPatternRule = AntiPatternStagedRule | ChangeSetRule;
export interface AntiPatternScriptResult {
  readonly hits: readonly AntiPatternHit[];
  readonly error?: string;
  readonly unavailable?: string;
  readonly skipped?: boolean;
  readonly stages?: Pick<StageExecution, "inputFiles" | "targetFiles" | "candidateFiles" | "records">;
}
export interface ExecuteAntiPatternOptions {
  readonly changeSet?: ChangeSetContext;
  readonly facts?: ProjectFacts;
  readonly scopes?: readonly AntiPatternScope[];
  readonly queryCache?: Map<string, Promise<readonly QueryMatch[]>>;
}

interface RuleExecution {
  readonly output?: readonly AntiPatternHitInput[];
  readonly error?: string;
  readonly unavailable?: string;
  readonly stages?: StageExecution;
}

export const isAntiPatternRule = (value: unknown): value is AntiPatternRule => {
  if (!value || typeof value !== "object") return false;
  const rule = value as Record<string, unknown>;
  if (rule.scope === "file" || rule.scope === "repository") return isStagedRuleContract(rule);
  return isChangeSetRule(rule);
};

const executeStagedAntiPatternRule = async (
  rule: AntiPatternStagedRule,
  files: readonly string[],
  parser: ParserService,
  options: ExecuteAntiPatternOptions,
  log: (...args: unknown[]) => void,
): Promise<RuleExecution> => {
  const execution = await executeStagedScript(rule, files, parser, {
    facts: options.facts,
    log,
    queryCache: options.queryCache,
  });
  if (execution.error) return { error: execution.error };
  if (execution.unavailable) return { unavailable: execution.unavailable };
  return { output: execution.output, stages: execution.stages };
};

/** Engine-owned text -> AST traversal prevents scripts from hiding unbounded scans or reversing pruning. */
export const executeAntiPatternRule = async (
  mjsPath: string,
  files: readonly string[],
  parser: ParserService,
  importFn: ScriptImport = (url) => import(url),
  options: ExecuteAntiPatternOptions = {},
): Promise<AntiPatternScriptResult> => {
  try {
    const loaded = await loadDefaultExport(mjsPath, importFn);
    if (loaded.error) return { hits: [], error: loaded.error };
    const candidate = loaded.value;
    if (!isAntiPatternRule(candidate)) return { hits: [], error: `${mjsPath}: 必须 export default；file/repository 规则导出 { scope, stages, link }；change_set 规则导出 { scope, detect }` };
    const rule = candidate;
    if (options.scopes && !options.scopes.includes(rule.scope)) return { hits: [], skipped: true };
    const log = (...args: unknown[]) => console.error("[openarch:anti-pattern]", ...args);
    const execution: RuleExecution = rule.scope === "change_set"
      ? await executeChangeSetRule(rule, parser, { changeSet: options.changeSet, facts: options.facts, log })
      : await executeStagedAntiPatternRule(rule, files, parser, options, log);
    if (execution.error) return { hits: [], error: `${mjsPath}: ${execution.error}` };
    if (execution.unavailable) return { hits: [], unavailable: execution.unavailable };
    const raw = execution.output ?? [];
    if (!raw.every(isAntiPatternHitInput)) return { hits: [], error: `${mjsPath}: 命中必须包含 ruleId/file/message 字符串字段` };
    const source = basename(mjsPath);
    return { hits: raw.map(hit => ({ ...hit, source, scope: rule.scope })), ...(execution.stages ? { stages: execution.stages } : {}) };
  } catch (error) {
    return { hits: [], error: `${mjsPath}: ${error instanceof Error ? error.message : String(error)}` };
  }
};
