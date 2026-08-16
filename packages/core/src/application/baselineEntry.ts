// Canonical projection from parser and graph facts into a persisted baseline entry.
// Scan and incremental diff must write the same fact contract.
import type { FileAst } from "../domain/ast";
import { weightedBranchTotalOf } from "../domain/branchMetrics";
import { localBurdenFingerprint } from "../domain/calibration";
import { computeConnectedness } from "../domain/cohesion";
import type { FileKind } from "../domain/testGovernance";
import { participatesInPopulation } from "../domain/fileParticipation";
import { toRelative } from "../infra/paths";
import type { IndexEntry } from "../port/StorageService";

export interface BaselineEntryInput {
  readonly ast: FileAst;
  readonly fileKind: FileKind;
  readonly inDegree: number;
  /** Callers must pass zero for non-production files. */
  readonly alphaStruct: number;
  readonly previous?: IndexEntry | null;
}

/**
 * Projects facts shared by complete scans and incremental updates. It intentionally
 * owns no graph or policy calculation, so callers cannot accidentally diverge on
 * persistence semantics while retaining their distinct analysis responsibilities.
 */
export const projectBaselineEntry = ({ ast, fileKind, inDegree, alphaStruct, previous }: BaselineEntryInput): IndexEntry => {
  const isProduction = participatesInPopulation(fileKind, "production-governance");
  const weightedBranchTotal = weightedBranchTotalOf(ast);
  const externalPassthroughCalls = ast.externalPassthroughCalls ?? ast.passthroughCalls;
  const localFingerprint = isProduction ? localBurdenFingerprint({
    maxFuncBranch: ast.maxFuncBranch ?? weightedBranchTotal,
    nestingDepth: ast.nestingDepth,
    loc: ast.loc,
    declarationLoc: ast.declarationLoc,
    externalPassthroughCalls,
    passthroughCalls: ast.passthroughCalls,
  }) : undefined;

  return {
    path: toRelative(ast.path),
    language: ast.language,
    fileKind,
    branchCount: ast.branchCount,
    weightedBranchTotal,
    topLevelWeightedBranch: ast.topLevelWeightedBranch,
    nestingDepth: ast.nestingDepth,
    inDegree,
    outDegree: ast.imports.length,
    alphaStruct: isProduction ? alphaStruct : 0,
    imports: ast.imports
      .map((ref) => ref.resolvedPath)
      .filter((path): path is string => path !== null)
      .map(toRelative),
    reexports: ast.imports
      .filter((ref) => ref.relation === "reexport")
      .map((ref) => ref.resolvedPath)
      .filter((path): path is string => path !== null)
      .map(toRelative),
    passthroughCalls: ast.passthroughCalls,
    loc: ast.loc,
    declarationLoc: ast.declarationLoc,
    maxFuncBranch: ast.maxFuncBranch,
    externalPassthroughCalls,
    connectedness: computeConnectedness(ast.functions),
    ...(localFingerprint ? {
      localBurdenFingerprint: localFingerprint,
      previousLocalBurdenFingerprint: previous?.localBurdenFingerprint,
    } : {}),
  };
};
