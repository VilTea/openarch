export type MetricRole = "gate" | "report_only" | "retired";
export type MetricRecommendationId = "split_function" | "inspect_branch_shape" | "extract_dispatch" | "reduce_local_burden";

export type CelVariableRole = MetricRole | "classifier";
export type CelVariableKind = "metric" | "classifier" | "composite";

export interface CelVariableDefinition {
  readonly id: string;
  readonly role: CelVariableRole;
  readonly kind: CelVariableKind;
  readonly recommendationId?: MetricRecommendationId;
}

export interface MetricDefinition extends CelVariableDefinition {
  readonly kind: "metric";
  readonly recommendationId?: MetricRecommendationId;
}

// v4 persists parser-confirmed file language so structural policy populations
// cannot reclassify entries from extension or directory heuristics at read time.
export const METRIC_CONTRACT_VERSION = "metric-contract-v4";

/**
 * CEL gate 变量的完整 authority（校准 2026-08-15）：
 * gate 规则只允许 role=gate 的 metric 与 role=classifier 的上下文变量；
 * report_only/retired 出现在规则里即 `unsupported_gate_metric`。
 */
const celVariables: readonly CelVariableDefinition[] = [
  { id: "max_func_branch", role: "gate", kind: "metric", recommendationId: "split_function" },
  { id: "crl_local", role: "gate", kind: "metric", recommendationId: "reduce_local_burden" },
  { id: "exposure", role: "gate", kind: "metric" },
  { id: "weighted_branch_total", role: "report_only", kind: "metric", recommendationId: "inspect_branch_shape" },
  { id: "top_level_branch", role: "report_only", kind: "metric", recommendationId: "extract_dispatch" },
  { id: "nesting_depth", role: "report_only", kind: "metric" },
  { id: "loc", role: "report_only", kind: "metric" },
  { id: "declaration_loc", role: "report_only", kind: "metric" },
  // 变更量是治理路由/解释证据，不是可裁决的门禁（校准 2026-08-15）：
  // 高 in-degree 文件被修改是正常演进，任何绝对阈值都随变更规模漂移。
  { id: "i_push", role: "report_only", kind: "metric" },
  { id: "branch_count", role: "retired", kind: "metric" },
  { id: "crl_state", role: "retired", kind: "composite" },
  { id: "module_shape", role: "report_only", kind: "composite" },
  { id: "crl_inputs", role: "retired", kind: "composite" },
  { id: "cohesion", role: "retired", kind: "metric" },
  { id: "function_count", role: "retired", kind: "metric" },
  // shadow research metric：尚无 CLI/策略消费者，不允许进入 gate 规则。
  { id: "symbol_scope", role: "retired", kind: "metric" },
  { id: "path_class", role: "classifier", kind: "classifier" },
  { id: "language", role: "classifier", kind: "classifier" },
];

export const celVariableDefinition = (id: string): CelVariableDefinition | undefined =>
  celVariables.find((definition) => definition.id === id);

export const metricDefinition = (id: string): MetricDefinition | undefined => {
  const definition = celVariableDefinition(id);
  return definition?.kind === "metric" ? definition as MetricDefinition : undefined;
};

/** 去掉字符串字面量后的 CEL 标识符集合。 */
const identifiersOutsideStrings = (condition: string): Set<string> =>
  new Set(condition.replace(/"[^"]*"|'[^']*'/g, " ").match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? []);

/** CEL 当前子集只有标识符/字面量；此解析由指标 authority 统一消费。 */
export const metricIdsInCondition = (condition: string): readonly string[] =>
  [...identifiersOutsideStrings(condition)].filter((id) => metricDefinition(id) !== undefined);

export const nonGateMetricsInCondition = (condition: string): readonly MetricDefinition[] =>
  metricIdsInCondition(condition)
    .map(metricDefinition)
    .filter((definition): definition is MetricDefinition => definition !== undefined && definition.role !== "gate");

/** 条件中引用但未在 authority 登记的标识符——必须 fail-closed，而不是按字符串黑名单猜测。 */
export const unknownCelVariablesInCondition = (condition: string): readonly string[] =>
  [...identifiersOutsideStrings(condition)].filter((id) => celVariableDefinition(id) === undefined).sort();

/** gate 条件只允许 gate metric + classifier；其余（report_only/retired/unknown）都不允许。 */
export const unsupportedCelVariablesInCondition = (condition: string): readonly string[] =>
  [...identifiersOutsideStrings(condition)]
    .map((id) => ({ id, definition: celVariableDefinition(id) }))
    .filter(({ id, definition }) => !definition || (definition.role !== "gate" && definition.role !== "classifier"))
    .map(({ id }) => id)
    .sort();
