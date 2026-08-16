// packages/core/src/application/diffImpact.ts
// 单文件冲击计算——I_push 4 因子 + D_MR 恶化值（纯函数，不含 Effect）。
import { reach } from "../domain/reach";
import { confidence } from "../domain/confidence";
import { alphaStruct } from "../domain/alpha";
import { computeIPush, computeSeverityBudget } from "../domain/i-push";
import type { ChangeKind } from "../domain/weights";
import type { FileAst } from "../domain/ast";
import type { DependencyGraph } from "../domain/graph";
import type { IndexEntry } from "../port/StorageService";
import { toAbsolute, toRelative } from "../infra/paths";
import { layerWeightOf } from "./pathClass";
import type { PathClass } from "./pathClass";
import { classifyFileKindWithPolicy, type FileKindRule } from "../domain/testGovernance";
import { participatesInPopulation } from "../domain/fileParticipation";
import { computeMRDiagnosis, type MRBeforeSource, type MRDiagnosis } from "../domain/mrDiagnosis";
import type { CRLStateWeights, P95Values } from "../domain/crlState";
import { weightedBranchTotalOf } from "../domain/branchMetrics";
import type { SemanticBeforeMetrics, SemanticBeforeState } from "./semanticDiff";
import { projectBaselineEntry } from "./baselineEntry";

// ── 单文件冲击输入 / 输出 ──

export interface ImpactInput {
  readonly ast: FileAst;
  readonly graph: DependencyGraph;
  readonly inDegrees: ReadonlyMap<string, number>;
  readonly reverseEdges: ReadonlyMap<string, readonly string[]>;
  readonly changedSet: ReadonlySet<string>;
  readonly nFiles: number;
  readonly changeKinds: readonly ChangeKind[];
  readonly pathClasses: readonly PathClass[];
  readonly oldEntry?: IndexEntry | null;   // 旧 per-file 指标（D_MR 用）
  /** Git/AST before facts override a mutable baseline when semantic evidence is available. */
  readonly semanticBefore?: SemanticBeforeMetrics;
  readonly semanticBeforeState?: SemanticBeforeState;
  readonly p95?: P95Values;
  readonly crlStateWeights: CRLStateWeights;
  readonly fileKindRules?: readonly FileKindRule[];
}

export interface ImpactOutput {
  readonly absPath: string;
  readonly relPath: string;
  readonly alphaStruct: number;
  readonly deltaI: number;
  /** Σ λ_ast × branchMagnitude（report-only 规模参照分母）；非生产文件为 0，与 deltaI 口径一致。 */
  readonly severityBudget: number;
  /** Baseline metric used for this calculation; pending revisions preserve it until sealing. */
  readonly oldEntry: IndexEntry | null;
  readonly writeEntry: Omit<IndexEntry, "path"> & { path: string };
  readonly mrDetail: MRDiagnosis;
  readonly contributionMR: number;  // 该文件的 D_MR 贡献
}

// ── 辅助 ──

/** 计算单个变更文件的冲击量 + D_MR 贡献 + writeEntry（纯函数，无副作用） */
export const computeFileImpact = (input: ImpactInput): ImpactOutput => {
  const { ast, inDegrees, nFiles, changeKinds, pathClasses, oldEntry } = input;
  const absPath = toAbsolute(ast.path);
  const relPath = toRelative(absPath);
  const fileKind = oldEntry?.fileKind ?? classifyFileKindWithPolicy(relPath, input.fileKindRules);
  const isProduction = participatesInPopulation(fileKind, "production-governance");

  const r = reach(input.reverseEdges, absPath);  // 反向图：blast radius
  const weightedControlFlow = weightedBranchTotalOf(ast);
  const c = confidence({ passthroughCalls: ast.passthroughCalls, weightedControlFlow, structuralNodeEstimate: Math.max(ast.passthroughCalls + weightedControlFlow + ast.functionCount, 1) });
  const a = alphaStruct({ reach: r, confidence: c, nFiles });
  const inDeg = inDegrees.get(absPath) ?? 0;
  const w = layerWeightOf(absPath, pathClasses);

  const previousWeightedControlFlow = input.semanticBeforeState === "git"
    ? input.semanticBefore?.weightedBranchTotal ?? 0
    : weightedBranchTotalOf(oldEntry ?? {});
  const pushes = changeKinds.map((changeKind) => ({
    changeKind, alphaStruct: a, inDegree: inDeg, layerWeight: w,
    weightedBranchDelta: weightedControlFlow - previousWeightedControlFlow,
  }));
  const dI = !isProduction ? 0 : computeIPush(pushes);
  const severityBudget = !isProduction ? 0 : computeSeverityBudget(pushes);

  // D_MR: 复用 CRL_state 的局部负担语义；暴露度单独呈现，不混成腐化分数。
  // 冷启动（无 baseline P95 分母）时无法同口径归一化恶化——即使 git before 存在，
  // 也诚实标为 unavailable，避免静默 0.00 误导。
  const noP95Denominator = input.p95 === undefined;
  const beforeSource: MRBeforeSource = noP95Denominator
    ? "unavailable"
    : input.semanticBeforeState === "git"
      ? "git"
      : input.semanticBeforeState === "introduced"
        ? "introduced"
        : oldEntry
          ? "baseline"
          : input.semanticBeforeState === "unavailable"
            ? "unavailable"
            : "introduced";
  const beforeMetrics = beforeSource === "git"
    ? input.semanticBefore
    : beforeSource === "baseline"
      ? oldEntry ?? undefined
      : undefined;
  const mrDetail = computeMRDiagnosis({
    file: ast.path,
    before: beforeMetrics,
    beforeSource,
    beforeAlpha: beforeSource === "baseline" ? oldEntry?.alphaStruct : undefined,
    after: {
      maxFuncBranch: ast.maxFuncBranch, branchCount: ast.branchCount,
      nestingDepth: ast.nestingDepth, loc: ast.loc,
      externalPassthroughCalls: ast.externalPassthroughCalls ?? ast.passthroughCalls,
      alphaStruct: a,
    },
    p95: input.p95,
    weights: input.crlStateWeights,
  });
  const dMR = isProduction ? mrDetail.localBurden.deterioration : 0;

  const writeEntry = projectBaselineEntry({ ast, fileKind, inDegree: inDeg, alphaStruct: a, previous: oldEntry });

  return {
    absPath, relPath, alphaStruct: a, deltaI: dI, severityBudget,
    oldEntry: oldEntry ?? null,
    writeEntry,
    mrDetail,
    contributionMR: dMR,
  };
};
