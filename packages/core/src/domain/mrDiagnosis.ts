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
}

export interface MRLocalMetricsInput {
  readonly maxFuncBranch?: number;
  readonly branchCount?: number;
  readonly nestingDepth?: number;
  readonly loc?: number;
  readonly externalPassthroughCalls?: number;
  readonly passthroughCalls?: number;
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
  return {
    file: input.file,
    scope: beforeSource === "introduced" ? "introduced" : beforeSource === "unavailable" ? "existing_unavailable" : "existing",
    beforeSource,
    localBurden: { metrics, deterioration, improvement },
    exposure: { before: beforeAlpha ?? null, after: input.after.alphaStruct, delta: beforeAlpha === undefined ? null : input.after.alphaStruct - beforeAlpha },
  };
};
