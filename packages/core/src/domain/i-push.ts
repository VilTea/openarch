// packages/core/src/domain/i-push.ts
// 公式4：单次 Push 冲击量（design v5.3 §7.2，λ_joint 冻结为研究项）
import { LAMBDA_AST, type ChangeKind } from "./weights";

/** 单文件变更的冲击量输入 */
export interface PushDeltaInput {
  readonly changeKind: ChangeKind;
  readonly alphaStruct: number;  // 公式3：该文件的结构显著性
  readonly inDegree: number;     // 仓库内入度（被多少文件依赖）
  readonly layerWeight?: number; // 公式4 因子4 ω_layer：层权重，缺省 1.0
  /** branch_add 的实际加权增量；缺省 1 保持旧调用兼容。 */
  readonly weightedBranchDelta?: number;
}

/** 变更的语义破坏度预算（severity budget）：Σ λ_ast × branchMagnitude。
 *  它是 I_push 的规模参照分母（report-only），不是另一个公式因子。 */
export const computeSeverityBudget = (
  deltas: readonly Pick<PushDeltaInput, "changeKind" | "weightedBranchDelta">[],
): number =>
  deltas.reduce((sum, d) => {
    const branchMagnitude = d.changeKind === "branch_add" ? Math.max(0, d.weightedBranchDelta ?? 1) : 1;
    return sum + LAMBDA_AST[d.changeKind] * branchMagnitude;
  }, 0);

/** 公式4（活跃形态）：I_push = Σ λ_ast × branchMagnitude × α_struct × log₂(入度_内部 + 1) × ω_layer
 *  layerWeight 缺省 1.0（无 path_class weight 配置时退化）。
 *  λ_joint 冻结为研究项，不再参与活跃公式（校准 2026-08-15，design v5.3 §7.2/§7.6）。 */
export const computeIPush = (deltas: readonly PushDeltaInput[]): number =>
  deltas.reduce((sum, d) => {
    const lambda = LAMBDA_AST[d.changeKind];
    const reachFactor = Math.log2(d.inDegree + 1);
    const layerWeight = d.layerWeight ?? 1.0;
    const branchMagnitude = d.changeKind === "branch_add" ? Math.max(0, d.weightedBranchDelta ?? 1) : 1;
    return sum + lambda * branchMagnitude * d.alphaStruct * reachFactor * layerWeight;
  }, 0);
