// packages/core/src/domain/alpha.ts

export interface AlphaInput {
  readonly reach: number;
  readonly confidence: number;
  /** 本次 scan 纳入的仓库文件总数（写入 baseline.json 的 meta.n_files） */
  readonly nFiles: number;
}

/**
 * 公式3：结构显著性（design v5.2 §7.1）
 *   α_struct(f) = log₂(Reach × Confidence + 1) / log₂(N_files + 1)
 *
 * 归一化到 [0, 1]，跨仓库可比。同一基线内所有 α_struct 共用 N_files。
 */
export const alphaStruct = (input: AlphaInput): number => {
  const { reach, confidence, nFiles } = input;
  const numerator = Math.log2(reach * confidence + 1);
  const denominator = Math.log2(nFiles + 1);
  if (denominator <= 0) return 0;
  const result = numerator / denominator;
  // Clamp to [0, 1] to handle floating-point precision issues
  return Math.min(1.0, Math.max(0, result));
};
