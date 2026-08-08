/**
 * 加权分支的三个互不替代的观察面。
 * branchCount 是旧 baseline 的兼容别名，语义等同 weightedBranchTotal。
 */
export interface BranchMetricSnapshot {
  readonly branchCount?: number;
  readonly weightedBranchTotal?: number;
  readonly maxFuncBranch?: number;
  readonly topLevelWeightedBranch?: number;
}

export const weightedBranchTotalOf = (metrics: BranchMetricSnapshot): number =>
  metrics.weightedBranchTotal ?? metrics.branchCount ?? 0;

/**
 * maxFuncBranch 与旧 branchCount 不同义。缺失时不能把文件聚合冒充函数复杂度；
 * gate 入口会以 0 表示该新维度在旧快照中不可用于触发阈值。
 */
export const maxFuncWeightedBranchOf = (metrics: BranchMetricSnapshot): number =>
  metrics.maxFuncBranch ?? 0; // 仅供 display/review 回退；gate 必须先验证快照完整性。

export const topLevelWeightedBranchOf = (metrics: BranchMetricSnapshot): number =>
  metrics.topLevelWeightedBranch ?? 0;
