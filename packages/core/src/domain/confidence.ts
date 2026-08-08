// packages/core/src/domain/confidence.ts

export interface ConfidenceInput {
  /** 透传调用数：函数体中"直接调用其他函数、无新增逻辑"的语句数 */
  readonly passthroughCalls: number;
  /** 分支逻辑数：if/switch/||/&& 等条件判断个数 */
  readonly weightedControlFlow: number;
  /** 结构上下文估计；当前由调用数、加权控制流和函数数构成。 */
  readonly structuralNodeEstimate: number;
}

/**
 * 公式2：中间层置信度（design v5.2 §7.1）
 *   Confidence(f) = clamp((透传调用数 + 0.3 × 加权控制流) / 结构上下文估计, 0.2, 1.0)
 *
 * 冷启动缺省 0.5（design §7.1）；此处公式自动计算。
 */
export const confidence = (input: ConfidenceInput): number => {
  const { passthroughCalls, weightedControlFlow, structuralNodeEstimate } = input;
  if (structuralNodeEstimate <= 0) return 0.2; // 除零保护 + 下界
  const raw = (passthroughCalls + 0.3 * weightedControlFlow) / structuralNodeEstimate;
  return Math.min(1.0, Math.max(0.2, raw));
};
