export type MetricRole = "gate" | "report_only" | "retired";
export type MetricRecommendationId = "split_function" | "inspect_branch_shape" | "extract_dispatch" | "reduce_local_burden" | "review_high_impact";

export interface MetricDefinition {
  readonly id: string;
  readonly role: MetricRole;
  readonly recommendationId?: MetricRecommendationId;
}

// v4 persists parser-confirmed file language so structural policy populations
// cannot reclassify entries from extension or directory heuristics at read time.
export const METRIC_CONTRACT_VERSION = "metric-contract-v4";

const definitions: readonly MetricDefinition[] = [
  { id: "max_func_branch", role: "gate", recommendationId: "split_function" },
  { id: "weighted_branch_total", role: "report_only", recommendationId: "inspect_branch_shape" },
  { id: "top_level_branch", role: "report_only", recommendationId: "extract_dispatch" },
  { id: "branch_count", role: "retired" },
  { id: "crl_local", role: "gate", recommendationId: "reduce_local_burden" },
  { id: "i_push", role: "gate", recommendationId: "review_high_impact" },
  { id: "exposure", role: "gate" },
  { id: "symbol_scope", role: "report_only" },
];

export const metricDefinition = (id: string): MetricDefinition | undefined => definitions.find((definition) => definition.id === id);

/** CEL 当前子集只有标识符/字面量；此解析由指标 authority 统一消费。 */
export const metricIdsInCondition = (condition: string): readonly string[] =>
  [...new Set(condition.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? [])].filter((id) => metricDefinition(id) !== undefined);

export const nonGateMetricsInCondition = (condition: string): readonly MetricDefinition[] =>
  metricIdsInCondition(condition)
    .map(metricDefinition)
    .filter((definition): definition is MetricDefinition => definition !== undefined && definition.role !== "gate");
