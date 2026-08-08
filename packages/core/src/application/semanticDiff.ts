import { Effect } from "effect";
import { resolve } from "node:path";
import type { FileAst } from "../domain/ast";
import type { ChangeSetContext } from "../anti-patterns/engine";
import { analyzeSemanticChanges, type SemanticChange } from "../domain/semanticChanges";
import { classifyFileKindWithPolicy } from "../domain/testGovernance";
import { readProjectFileKindRules } from "../projectFiles";
import { ParserService } from "../port/ParserService";

export interface SemanticBeforeMetrics {
  readonly weightedBranchTotal: number;
  readonly maxFuncBranch?: number;
  readonly nestingDepth: number;
  readonly loc: number;
  readonly externalPassthroughCalls: number;
}

/**
 * Semantic classification and structural comparison have different evidence
 * boundaries. A manual change kind must not turn an existing Git file into an
 * introduced one merely because its declaration surface was unavailable.
 */
export type SemanticBeforeState = "git" | "introduced" | "unavailable";

export interface SemanticFileProfile {
  readonly file: string;
  readonly changes: readonly SemanticChange[];
  /** Direct Git-AST structure, available independently from the chosen change kind. */
  readonly beforeMetrics?: SemanticBeforeMetrics;
  readonly beforeState: SemanticBeforeState;
}

export type SemanticDiffReport =
  | { readonly availability: "available"; readonly profiles: readonly SemanticFileProfile[] }
  | { readonly availability: "partial" | "unavailable"; readonly profiles: readonly []; readonly reason: string };

export interface SemanticDiffOptions {
  /** Restricts a bounded revision to the files relevant to its caller's evidence question. */
  readonly paths?: readonly string[];
}

const beforeMetricsOf = (ast: FileAst): SemanticBeforeMetrics => ({
  weightedBranchTotal: ast.weightedBranchTotal ?? ast.branchCount,
  maxFuncBranch: ast.maxFuncBranch,
  nestingDepth: ast.nestingDepth,
  loc: ast.loc ?? 0,
  externalPassthroughCalls: ast.externalPassthroughCalls ?? ast.passthroughCalls,
});

/**
 * Converts a bounded Git before/after change set into declaration-level facts.
 * Git is supplied by the CLI/application boundary; project scripts never call
 * this use case or receive revision source.
 */
export const analyzeChangeSetSemantics = (cwd: string, changeSet: ChangeSetContext, options: SemanticDiffOptions = {}) =>
  Effect.gen(function* () {
    if (changeSet.availability !== "available") {
      return { availability: changeSet.availability, profiles: [], reason: changeSet.reason ?? "Git change set is incomplete" } satisfies SemanticDiffReport;
    }
    const parser = yield* ParserService;
    const fileKindRules = readProjectFileKindRules(cwd);
    const profiles: SemanticFileProfile[] = [];
    const requested = options.paths ? new Set(options.paths.map((path) => path.replace(/\\/g, "/"))) : undefined;
    const files = requested ? changeSet.files.filter((file) => requested.has(file.path.replace(/\\/g, "/"))) : changeSet.files;
    if (requested && files.length === 0) {
      return { availability: "unavailable", profiles: [], reason: "requested historical files are absent from the revision" } satisfies SemanticDiffReport;
    }
    for (const file of files) {
      const isNonProduction = classifyFileKindWithPolicy(file.path, fileKindRules) !== "production";
      const fallback = (): SemanticFileProfile => ({
        file: file.path,
        changes: [{ anchor: "non-production:file", kind: "function_body" }],
        beforeState: file.kind === "added" ? "introduced" : "unavailable",
      });
      if (file.kind === "deleted" || !file.afterText) {
        return { availability: "unavailable", profiles: [], reason: `${file.path}: deleted or unreadable after source` } satisfies SemanticDiffReport;
      }
      const path = resolve(cwd, file.path);
      const parsed = yield* Effect.all({
        before: file.beforeText ? parser.parseText(path, file.beforeText).pipe(Effect.option) : Effect.succeed(undefined),
        after: parser.parseText(path, file.afterText).pipe(Effect.option),
      });
      const before = parsed.before && parsed.before._tag === "Some" ? parsed.before.value : undefined;
      const after = parsed.after && parsed.after._tag === "Some" ? parsed.after.value : undefined;
      if (file.beforeText && !before) {
        if (isNonProduction) { profiles.push(fallback()); continue; }
        return { availability: "unavailable", profiles: [], reason: `${file.path}: cannot parse before source` } satisfies SemanticDiffReport;
      }
      if (!after) {
        if (isNonProduction) { profiles.push(fallback()); continue; }
        return { availability: "unavailable", profiles: [], reason: `${file.path}: cannot parse after source` } satisfies SemanticDiffReport;
      }
      const result = analyzeSemanticChanges(before, after);
      if (result.availability !== "available") {
        if (isNonProduction) { profiles.push(fallback()); continue; }
        return { availability: "unavailable", profiles: [], reason: `${file.path}: ${result.reason}` } satisfies SemanticDiffReport;
      }
      profiles.push({
        file: file.path,
        changes: result.changes,
        beforeState: before ? "git" : "introduced",
        ...(before ? { beforeMetrics: beforeMetricsOf(before) } : {}),
      });
    }
    return { availability: "available", profiles } satisfies SemanticDiffReport;
  });
