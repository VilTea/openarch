// packages/core/src/domain/i-push.ts
// 公式4：单次 Push 冲击量（design v5.2 §7.2）
import { LAMBDA_AST, type ChangeKind } from "./weights";

/** 单文件变更的冲击量输入 */
export interface PushDeltaInput {
  readonly changeKind: ChangeKind;
  readonly alphaStruct: number;  // 公式3：该文件的结构显著性
  readonly inDegree: number;     // 仓库内入度（被多少文件依赖）
  readonly layerWeight?: number; // 公式4 因子4 ω_layer：层权重，缺省 1.0
  readonly lambdaJoint?: number; // 公式4 因子5 λ_joint：联合判定（γ_completion），缺省 1.0
  /** branch_add 的实际加权增量；缺省 1 保持旧调用兼容。 */
  readonly weightedBranchDelta?: number;
}

/** 公式4：I_push = Σ λ_ast × α_struct × log₂(入度_内部 + 1) × ω_layer × λ_joint
 *  layerWeight 缺省 1.0（无 path_class weight 配置时退化），lambdaJoint 缺省 1.0（无 γ_completion 时退化） */
export const computeIPush = (deltas: readonly PushDeltaInput[]): number =>
  deltas.reduce((sum, d) => {
    const lambda = LAMBDA_AST[d.changeKind];
    const reachFactor = Math.log2(d.inDegree + 1);
    const layerWeight = d.layerWeight ?? 1.0;
    const lambdaJoint = d.lambdaJoint ?? 1.0;
    const branchMagnitude = d.changeKind === "branch_add" ? Math.max(0, d.weightedBranchDelta ?? 1) : 1;
    return sum + lambda * branchMagnitude * d.alphaStruct * reachFactor * layerWeight * lambdaJoint;
  }, 0);
