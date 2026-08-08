import { Effect } from "effect";
import type { ParserService } from "../port/ParserService";
import { staticImportSources } from "../staged-analysis/staticImports";
import {
  authorityIdsForPath,
  emptyProjectFacts,
  isScriptAuthorityDeclaration,
  isScriptFactRequirements,
  unavailableRequiredFact,
  withRuleLocalAuthority,
  type ProjectFacts,
  type ScriptAuthorityDeclaration,
  type ScriptFactCapability,
} from "../script-runtime/projectFacts";

export type ChangeSetAvailability = "available" | "partial" | "unavailable";

export interface ChangeSetFile {
  readonly path: string;
  /** Previous repository-relative path for a Git-detected rename. */
  readonly beforePath?: string;
  readonly kind: "added" | "modified" | "deleted";
  readonly beforeText?: string;
  readonly afterText?: string;
  /** Engine-derived raw import sources from parser-confirmed before/after text. */
  readonly beforeStaticImports?: readonly string[];
  readonly afterStaticImports?: readonly string[];
  /** Engine-derived authority membership; change-set rules must not re-match protected paths. */
  readonly authorityIds?: readonly string[];
}

/** Transient, engine-owned Git facts exposed to change-set rules. */
export interface ChangeSetContext {
  readonly availability: ChangeSetAvailability;
  readonly files: readonly ChangeSetFile[];
  readonly reason?: string;
}

export type AntiPatternCategory = "quality" | "security" | "correctness" | "testing" | "workflow";
export type AntiPatternSeverity = "error" | "warning" | "info";

const antiPatternCategories: readonly AntiPatternCategory[] = ["quality", "security", "correctness", "testing", "workflow"];
const antiPatternSeverities: readonly AntiPatternSeverity[] = ["error", "warning", "info"];

const isAntiPatternCategory = (value: unknown): value is AntiPatternCategory =>
  typeof value === "string" && antiPatternCategories.includes(value as AntiPatternCategory);

const isAntiPatternSeverity = (value: unknown): value is AntiPatternSeverity =>
  typeof value === "string" && antiPatternSeverities.includes(value as AntiPatternSeverity);

export interface AntiPatternHitInput {
  readonly ruleId: string;
  readonly file: string;
  readonly message: string;
  /** 1-based source location when the rule has parser-confirmed evidence. */
  readonly line?: number;
  readonly endLine?: number;
  readonly evidence?: string;
  /** Report-only explanation metadata; project policy remains independent. */
  readonly category?: AntiPatternCategory;
  readonly severity?: AntiPatternSeverity;
  readonly patternFamily?: string;
  readonly suggestion?: string;
}

export interface ChangeSetRuleContext {
  readonly changeSet: ChangeSetContext;
  readonly facts: ProjectFacts;
  readonly log: (...args: unknown[]) => void;
}

export type ChangeSetRule = {
  readonly scope: "change_set";
  readonly requires?: readonly ScriptFactCapability[];
  readonly authority?: ScriptAuthorityDeclaration;
  /** Parse bounded before/after text through the language strategy before detect runs. */
  readonly staticImports?: true;
  readonly detect: (ctx: ChangeSetRuleContext) => Promise<readonly AntiPatternHitInput[]> | readonly AntiPatternHitInput[];
};

export interface ChangeSetExecutionOptions {
  readonly changeSet?: ChangeSetContext;
  readonly facts?: ProjectFacts;
  readonly log: (...args: unknown[]) => void;
}

export interface ChangeSetExecutionResult {
  readonly output?: readonly AntiPatternHitInput[];
  readonly error?: string;
  readonly unavailable?: string;
}

export const isAntiPatternHitInput = (value: unknown): value is AntiPatternHitInput => {
  if (!value || typeof value !== "object") return false;
  const hit = value as Record<string, unknown>;
  return typeof hit.ruleId === "string" && typeof hit.file === "string" && typeof hit.message === "string"
    && (hit.line === undefined || (typeof hit.line === "number" && Number.isInteger(hit.line) && hit.line > 0))
    && (hit.endLine === undefined || (typeof hit.endLine === "number" && Number.isInteger(hit.endLine) && hit.endLine > 0))
    && (hit.evidence === undefined || typeof hit.evidence === "string")
    && (hit.category === undefined || isAntiPatternCategory(hit.category))
    && (hit.severity === undefined || isAntiPatternSeverity(hit.severity))
    && (hit.patternFamily === undefined || (typeof hit.patternFamily === "string" && hit.patternFamily.length > 0))
    && (hit.suggestion === undefined || (typeof hit.suggestion === "string" && hit.suggestion.length > 0));
};

export const isChangeSetRule = (value: Record<string, unknown>): value is ChangeSetRule =>
  value.scope === "change_set" && typeof value.detect === "function" && isScriptFactRequirements(value.requires)
  && (value.authority === undefined || isScriptAuthorityDeclaration(value.authority))
  && (value.staticImports === undefined || value.staticImports === true);

const enrichStaticImports = async (
  changeSet: ChangeSetContext,
  parser: ParserService,
): Promise<{ readonly changeSet?: ChangeSetContext; readonly unavailable?: string }> => {
  const files: ChangeSetFile[] = [];
  for (const file of changeSet.files) {
    try {
      const beforeStaticImports = file.beforeText === undefined
        ? []
        : staticImportSources(await Effect.runPromise(parser.parseText(file.path, file.beforeText)));
      const afterStaticImports = file.afterText === undefined
        ? []
        : staticImportSources(await Effect.runPromise(parser.parseText(file.path, file.afterText)));
      files.push({ ...file, beforeStaticImports, afterStaticImports });
    } catch (error) {
      return { unavailable: `static-imports.v1 unavailable for ${file.path}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { changeSet: { ...changeSet, files } };
};

/** Executes bounded Git change-set rules without duplicating the staged-script runtime. */
export const executeChangeSetRule = async (
  rule: ChangeSetRule,
  parser: ParserService,
  options: ChangeSetExecutionOptions,
): Promise<ChangeSetExecutionResult> => {
  const baseFacts = options.facts ?? emptyProjectFacts();
  const localAuthority = rule.authority ? withRuleLocalAuthority(baseFacts, rule.authority) : { facts: baseFacts };
  if (!localAuthority.facts) {
    return localAuthority.error ? { error: localAuthority.error } : { unavailable: localAuthority.unavailable };
  }
  if (!options.changeSet || options.changeSet.availability === "unavailable") {
    return { unavailable: options.changeSet?.reason ?? "change-set Git context is unavailable" };
  }
  const facts = localAuthority.facts;
  const unavailable = unavailableRequiredFact(
    [...new Set([...(rule.requires ?? []), ...(rule.authority ? ["authorities.v1" as const] : [])])],
    facts,
  );
  if (unavailable) return { unavailable: `${unavailable} is unavailable or partial` };
  const imports = rule.staticImports ? await enrichStaticImports(options.changeSet, parser) : { changeSet: options.changeSet };
  if (!imports.changeSet) return { unavailable: imports.unavailable };
  const changeSet = {
    ...imports.changeSet,
    files: imports.changeSet.files.map((file) => ({
      ...file,
      authorityIds: authorityIdsForPath(facts.authorities.value ?? [], file.path),
    })),
  };
  return { output: await Promise.resolve(rule.detect({ changeSet, facts, log: options.log })) };
};
