// packages/core/src/domain/p95.ts
// 第 95 百分位数（线性插值），CRL_state 归一化基准用。
// 用 P95 而非 max——避免 outlier 文件主导归一化分母。

/** 从 values 数组计算第 95 百分位数（线性插值）。空数组返回 0。 */
export const p95 = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = 0.95 * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
};
