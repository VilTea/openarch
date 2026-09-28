import type { CRLStateWeights, P95Values } from "./crlState";

export type MRChangeScope = "existing" | "introduced" | "existing_unavailable";
export type MRBeforeSource = "git" | "baseline" | "introduced" | "unavailable";
export type MRLocalMetric = "branch" | "nesting" | "loc" | "externalPassthrough";

export interface MRLocalMetricDelta {
  readonly before: number | null;
  readonly after: number;
  readonly delta: number | null;
  /** P95 归一化后再乘 CRL_state 权重；缺少有效 P95 时为 null。 */
  readonly normalizedDelta: number | null;
}

export interface MRLocalBurdenDiagnosis {
  readonly metrics: Readonly<Record<MRLocalMetric, MRLocalMetricDelta>>;
  /** 正向局部负担，不与改善项抵消。 */
  readonly deterioration: number;
  /** 负向局部负担，单独保留为重构收益。 */
  readonly improvement: number;
}

export interface MRExposureDiagnosis {
  readonly before: number | null;
  readonly after: number;
  /** Null when before local facts came from Git AST but its historical graph was not reconstructed. */
  readonly delta: number | null;
}

/** D_MR 只汇总 localBurden.deterioration；暴露度单独呈现为验证提示。 */
export interface MRDiagnosis {
  readonly file: string;
  readonly scope: MRChangeScope;
  /** D_MR is comparable only when its before structure is available. */
  readonly beforeSource: MRBeforeSource;
  readonly localBurden: MRLocalBurdenDiagnosis;
  readonly exposure: MRExposureDiagnosis;
  /** 认知点形态：并列呈现，不进入 D_MR 数值，不与局部负担互相抵消。 */
  readonly shape: MRShapeDiagnosis;
}

export interface MRLocalMetricsInput {
  readonly maxFuncBranch?: number;
  readonly branchCount?: number;
  readonly nestingDepth?: number;
  readonly loc?: number;
  readonly externalPassthroughCalls?: number;
  readonly passthroughCalls?: number;
  /** 认知点形态输入（report-only），不参与 localBurden 求和。 */
  readonly connectedness?: number;
  readonly functionCount?: number;
  /** 单调用点助手占比（与 connectedness 同源的内部调用图形状投影）。 */
  readonly singleCallSiteRatio?: number;
}

/**
 * 认知点形态（report-only）：**不并入 `localBurden` 的恶化/改善求和**，只是并列呈现。
 *
 * 存在理由（校准 2026-09-25）：机械分解可以让 `maxFuncBranch` 下降、
 * gate 变绿，同时让文件更碎（连通度下降）并新增只有一个调用点的助手。
 * 认知点原则说“新增抽象但只有 1 个调用者通常是净增加”，
 * 因此这两项代价必须在同一份变更诊断里可见，而不是留给使用方自己发现。
 * 缺失一律为 `null`，绝不用 0 冒充。
 */
export interface MRShapeDiagnosis {
  readonly connectednessBefore: number | null;
  readonly connectednessAfter: number | null;
  /** `1 - connectedness` 的变化：> 0 表示文件更碎（与 gate 的 `moduleShape` 同向）。 */
  readonly moduleShapeDelta: number | null;
  /** 函数/声明数量变化：> 0 表示新增了抽象。 */
  readonly functionCountDelta: number | null;
  /**
   * 单调用点助手占比的变化：> 0 表示新增的抽象里"只用一次"的比例上升。
   *
   * 与 `moduleShapeDelta` 是**同一张内部调用图**的两个投影，必须并读：纯机械分解的典型形态是
   * `moduleShapeDelta` 很小（助手都被主函数调用，图仍然连通）而本值明显上升——
   * 只看连通性会把"一堆一次性助手"读成健康。
   */
  readonly singleCallSiteRatioDelta: number | null;
}

export interface MRDiagnosisInput {
  readonly file: string;
  readonly before?: MRLocalMetricsInput & { readonly alphaStruct?: number };
  readonly beforeSource?: MRBeforeSource;
  /** Lets callers explicitly preserve an available structural exposure baseline. */
  readonly beforeAlpha?: number;
  readonly after: MRLocalMetricsInput & { readonly alphaStruct: number };
  readonly p95?: P95Values;
  readonly weights: CRLStateWeights;
}

const valuesFor = (input: MRLocalMetricsInput) => ({
  branch: input.maxFuncBranch ?? input.branchCount ?? 0,
  nesting: input.nestingDepth ?? 0,
  loc: input.loc ?? 0,
  externalPassthrough: input.externalPassthroughCalls ?? input.passthroughCalls ?? 0,
});

const p95For = (p95: P95Values, metric: MRLocalMetric): number => {
  switch (metric) {
    case "branch": return p95.branch;
    case "nesting": return p95.nesting;
    case "loc": return p95.loc;
    case "externalPassthrough": return p95.externalPassthrough;
  }
};

const weightFor = (weights: CRLStateWeights, metric: MRLocalMetric): number => {
  switch (metric) {
    case "branch": return weights.branch;
    case "nesting": return weights.nesting;
    case "loc": return weights.loc;
    case "externalPassthrough": return weights.externalPassthrough;
  }
};

/**
 * 以 CRL_state 相同的局部负担语义解释一次变更。
 * 差分不截断：超过 P95 后继续恶化仍须记录；改善与恶化不互相抵消。
 */
export const computeMRDiagnosis = (input: MRDiagnosisInput): MRDiagnosis => {
  const afterValues = valuesFor(input.after);
  const metrics = {} as Record<MRLocalMetric, MRLocalMetricDelta>;
  let deterioration = 0;
  let improvement = 0;
  const beforeSource = input.beforeSource ?? (input.before ? "git" : "introduced");
  const isComparable = input.before !== undefined && (beforeSource === "git" || beforeSource === "baseline");
  const beforeValues = isComparable ? valuesFor(input.before) : undefined;

  for (const metric of ["branch", "nesting", "loc", "externalPassthrough"] as const) {
    const before = beforeValues?.[metric] ?? null;
    const after = afterValues[metric];
    const delta = before === null ? null : after - before;
    const denominator = input.p95 ? p95For(input.p95, metric) : 0;
    const normalizedDelta = delta !== null && denominator > 0 ? weightFor(input.weights, metric) * delta / denominator : null;
    metrics[metric] = { before, after, delta, normalizedDelta };
    if (normalizedDelta !== null) {
      if (normalizedDelta > 0) deterioration += normalizedDelta;
      if (normalizedDelta < 0) improvement += -normalizedDelta;
    }
  }

  const beforeAlpha = isComparable ? input.beforeAlpha ?? input.before?.alphaStruct : undefined;
  // 形态事实同样只在 before 可比时给出差值；任一侧缺失即 null，不用 0 冒充。
  const connectednessBefore = isComparable ? input.before?.connectedness ?? null : null;
  const connectednessAfter = input.after.connectedness ?? null;
  const functionCountBefore = isComparable ? input.before?.functionCount ?? null : null;
  const functionCountAfter = input.after.functionCount ?? null;
  // 单调用点占比：任一侧不可判定（null/缺失）就不给差值——"没有可判定的助手"不是 0。
  const singleBefore = isComparable ? input.before?.singleCallSiteRatio ?? null : null;
  const singleAfter = input.after.singleCallSiteRatio ?? null;
  return {
    file: input.file,
    scope: beforeSource === "introduced" ? "introduced" : beforeSource === "unavailable" ? "existing_unavailable" : "existing",
    beforeSource,
    localBurden: { metrics, deterioration, improvement },
    exposure: { before: beforeAlpha ?? null, after: input.after.alphaStruct, delta: beforeAlpha === undefined ? null : input.after.alphaStruct - beforeAlpha },
    shape: {
      connectednessBefore,
      connectednessAfter,
      moduleShapeDelta: connectednessBefore === null || connectednessAfter === null
        ? null : (1 - connectednessAfter) - (1 - connectednessBefore),
      functionCountDelta: functionCountBefore === null || functionCountAfter === null
        ? null : functionCountAfter - functionCountBefore,
      singleCallSiteRatioDelta: singleBefore === null || singleAfter === null
        ? null : singleAfter - singleBefore,
    },
  };
};
