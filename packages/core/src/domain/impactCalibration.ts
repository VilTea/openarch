// packages/core/src/domain/impactCalibration.ts
// 冲击量规模参照（report-only，校准 2026-08-15）：
//   - intensity：每单位语义破坏度（Σ λ_ast × branchMagnitude）的结构冲击；
//   - projectRelative：与项目自身 sealed history 中同规模变更的分位比较。
// 这些量只用于路由验证强度与解释冲击，不进入 gate、CRL 或公式。

export interface HistoryImpactFact {
  readonly timestamp: string;
  /** 该历史条目的 I_push 总量（Σ deltaI）。 */
  readonly iPush: number;
  /** 该历史条目涉及的变更文件数。 */
  readonly fileCount: number;
  /** 该事实代表的原始 history entry 数；压缩 checkpoint 携带 sourceEntryCount。 */
  readonly entryCount: number;
}

export interface ImpactFileCountBucket {
  readonly label: string;
  readonly min: number;
  readonly max: number;
}

/** 变更文件数分桶：分位必须在同规模桶内比较，否则 1 文件与 30 文件迁移不可比。 */
export const IMPACT_FILE_COUNT_BUCKETS: readonly ImpactFileCountBucket[] = [
  { label: "1", min: 1, max: 1 },
  { label: "2-3", min: 2, max: 3 },
  { label: "4-9", min: 4, max: 9 },
  { label: "10-19", min: 10, max: 19 },
  { label: "20+", min: 20, max: Number.POSITIVE_INFINITY },
];

export const impactFileCountBucket = (fileCount: number): ImpactFileCountBucket | undefined =>
  IMPACT_FILE_COUNT_BUCKETS.find((bucket) => fileCount >= bucket.min && fileCount <= bucket.max);

export interface ImpactScale {
  /** 本次变更高于同规模历史变更的百分比（0–100，weighted by entryCount）。 */
  readonly percentile: number;
  readonly bucket: string;
  /** 同规模桶内的加权历史条目数（含 checkpoint sourceEntryCount）。 */
  readonly sampleEntries: number;
}

export const impactIntensityOf = (iPush: number, severityBudget: number): number =>
  severityBudget > 0 ? iPush / severityBudget : 0;

/**
 * 项目内同规模分位（compaction-safe）：只比较同一文件数桶内的 sealed history，
 * checkpoint 按 sourceEntryCount 加权，避免把 247 条压缩记录当成一条巨变。
 * 无同规模样本返回 undefined——不是 0 分位，也不是 clean。
 */
export const impactScaleOf = (
  iPush: number,
  fileCount: number,
  facts: readonly HistoryImpactFact[],
): ImpactScale | undefined => {
  const bucket = impactFileCountBucket(fileCount);
  if (!bucket) return undefined;
  const sameBucket = facts.filter((fact) => fact.fileCount >= bucket.min && fact.fileCount <= bucket.max);
  const total = sameBucket.reduce((sum, fact) => sum + Math.max(0, fact.entryCount), 0);
  if (total <= 0) return undefined;
  const below = sameBucket.reduce((sum, fact) => sum + (fact.iPush < iPush ? Math.max(0, fact.entryCount) : 0), 0);
  return { percentile: Math.round((below / total) * 1000) / 10, bucket: bucket.label, sampleEntries: total };
};
