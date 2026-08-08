import type { QueryMatch } from "../port/ParserService";
import {
  isScriptAuthorityDeclaration,
  isScriptFactRequirements,
  isScriptFileTargets,
  type ChangeSurfaceHunk,
  type ProjectFacts,
  type ScriptAuthorityDeclaration,
  type ScriptFactCapability,
  type ScriptFileTargets,
} from "../script-runtime/projectFacts";

/** Engine-owned progressive pruning: text candidates precede AST records.
 *  `files` 是默认候选（变更模式下为变更文件）；`allFiles` 是补充的全量候选
 *  ——需要全量 records × 变更面交叉的脚本（消费者模式等）显式取 allFiles，
 *  默认脚本行为不受变更面影响（校准 2026-08-07）。 */
export interface TextStage {
  (ctx: { files: readonly string[]; allFiles?: readonly string[]; text: (path: string) => string; facts: ProjectFacts }): string[];
}

export interface QueryAstStage {
  readonly pattern: string;
  readonly extract?: (
    matches: readonly QueryMatch[],
    file: string,
    change?: AstChangeContext,
  ) => Record<string, unknown>[];
}

/** Change-time context engine-injected into AST extraction when the change
 *  surface is available (change mode). `changedLines` are 1-based lines in the
 *  working file (after) touched by the diff; `hunks` carry the semantic
 *  containers (method/class) for those lines. Rules that only care about the
 *  changed part can filter matches by `change.changedLines.has(match.startLine)`. */
export interface AstChangeContext {
  readonly changedLines?: ReadonlySet<number>;
  readonly hunks?: readonly ChangeSurfaceHunk[];
}

/** ParserStrategy owns grammar differences and exposes raw static import sources as records. */
export interface StaticImportsAstStage {
  readonly fact: "static-imports.v1";
}

export type AstStage = QueryAstStage | StaticImportsAstStage;

/** Engine-provided AST facts are selected by stages, not declared in `requires`. */
export const SCRIPT_AST_FACTS = [{
  id: "static-imports.v1",
  summaryId: "scriptFact.staticImports.summary",
}] as const;

export interface StageRecord {
  readonly _file: string;
  readonly [key: string]: unknown;
}

export interface StagedAnalysis {
  readonly text?: TextStage;
  readonly ast?: AstStage;
}

export const isStaticImportsAstStage = (stage: AstStage): stage is StaticImportsAstStage =>
  "fact" in stage && stage.fact === "static-imports.v1";

const isAstStage = (value: unknown): value is AstStage => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stage = value as Record<string, unknown>;
  if (stage.fact === "static-imports.v1") return Object.keys(stage).every((key) => key === "fact");
  return typeof stage.pattern === "string" && (stage.extract === undefined || typeof stage.extract === "function");
};

export const isStagedAnalysis = (value: unknown): value is StagedAnalysis => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stages = value as Record<string, unknown>;
  return Object.keys(stages).every((key) => key === "text" || key === "ast")
    && (stages.text === undefined || typeof stages.text === "function")
    && (stages.ast === undefined || isAstStage(stages.ast));
};

export interface StagedLinkContext {
  readonly records: readonly StageRecord[];
  readonly log: (...args: unknown[]) => void;
  /** Versioned, engine-injected project facts. Rules never read config or baseline directly. */
  readonly facts: ProjectFacts;
}

/** Shared project-script shape: the engine owns traversal; the script owns only semantic linking. */
export interface StagedRule<Result> {
  readonly stages: StagedAnalysis;
  /** Engine rejects incomplete facts instead of letting a rule interpret absence as zero. */
  readonly requires?: readonly ScriptFactCapability[];
  /** Declarative, engine-owned file prefilter before text -> AST -> link. */
  readonly targets?: ScriptFileTargets;
  /** Private to one script; reusable project boundaries remain in authority_hygiene. */
  readonly authority?: ScriptAuthorityDeclaration;
  readonly link: (ctx: StagedLinkContext) => Promise<readonly Result[]> | readonly Result[];
}

/** Shared runtime contract so every project-script domain accepts local authority consistently. */
export const isStagedRuleContract = (value: unknown): value is StagedRule<unknown> => {
  if (!value || typeof value !== "object") return false;
  const rule = value as Record<string, unknown>;
  return isStagedAnalysis(rule.stages)
    && typeof rule.link === "function"
    && isScriptFactRequirements(rule.requires)
    && isScriptFileTargets(rule.targets)
    && (rule.authority === undefined || isScriptAuthorityDeclaration(rule.authority));
};

export interface StageExecution {
  readonly inputFiles: number;
  readonly targetFiles: readonly string[];
  readonly candidateFiles: readonly string[];
  readonly records: readonly StageRecord[];
}
