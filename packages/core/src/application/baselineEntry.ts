// Canonical projection from parser and graph facts into a persisted baseline entry.
// Scan and incremental diff must write the same fact contract.
import type { FileAst, FunctionInfo, MaxFuncBranchOwner } from "../domain/ast";
import { weightedBranchTotalOf } from "../domain/branchMetrics";
import { localBurdenFingerprint } from "../domain/calibration";
import { computeInternalCallShape } from "../domain/cohesion";
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
 * 单函数最大加权分支的归属与形态（report-only）。
 * 与 `maxFuncBranch` 出自同一次解析，只投影**一个**函数，因此不构成第二套函数级事实：
 * 报告需要的信息（哪个函数、多少行、加权值由什么构成）在这一处定义，其他地方只消费。
 */
const maxFuncBranchOwnerOf = (functions: readonly FunctionInfo[]): MaxFuncBranchOwner | undefined => {
  let best: FunctionInfo | undefined;
  for (const fn of functions) if (!best || fn.branchCount > best.branchCount) best = fn;
  if (!best || best.branchCount <= 0) return undefined;
  return {
    name: best.name,
    ...(best.line !== undefined ? { line: best.line } : {}),
    weighted: best.branchCount,
    ordinaryIf: best.ordinaryBranches ?? 0,
    guardIf: best.guardBranches ?? 0,
    caseCount: best.caseBranches ?? 0,
  };
};

/**
 * Projects facts shared by complete scans and incremental updates. It intentionally
 * owns no graph or policy calculation, so callers cannot accidentally diverge on
 * persistence semantics while retaining their distinct analysis responsibilities.
 */
export const projectBaselineEntry = ({ ast, fileKind, inDegree, alphaStruct, previous }: BaselineEntryInput): IndexEntry => {
  const isProduction = participatesInPopulation(fileKind, "production-governance");
  const weightedBranchTotal = weightedBranchTotalOf(ast);
  const externalPassthroughCalls = ast.externalPassthroughCalls ?? ast.passthroughCalls;
  const maxFuncBranchOwner = isProduction ? maxFuncBranchOwnerOf(ast.functions) : undefined;
  // 内部调用图形状一次算出：connectedness 与单调用点助手占比是同一张图的两个投影，
  // 分开算就是两次遍历、两个可能漂移的口径（认知点原则：一个概念一个入口）。
  const callShape = computeInternalCallShape(ast.functions);
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
    connectedness: callShape.connectedness,
    ...(callShape.singleCallSiteRatio === null ? {} : { singleCallSiteRatio: callShape.singleCallSiteRatio }),
    ...(maxFuncBranchOwner ? { maxFuncBranchOwner } : {}),
    ...(localFingerprint ? {
      localBurdenFingerprint: localFingerprint,
      previousLocalBurdenFingerprint: previous?.localBurdenFingerprint,
    } : {}),
  };
};
