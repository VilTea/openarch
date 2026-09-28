// packages/core/src/application/governance/gateApp.ts
// gate 命令——数据流管道。Effect.gen 编排 I/O 步骤，纯函数渲染。
import { Effect } from "effect";
import { gatePerFile, type GateTrigger, type GateVerdict } from "./gate";
import { loadGateConfigStrict, unsupportedMetricRules, GateConfigurationError, type GateConfig } from "./gateConfig";
import { gateReportFacts, type GateFileMetric, type GateReportFacts, type GateThresholdFact } from "./gateReport";
import { isPathInAnalysisScope, type AnalysisScope } from "../../domain/analysisScope";
import { METRIC_CONTRACT_VERSION, numericGateThresholdsInCondition, unsupportedCelVariablesInCondition } from "../../domain/metricCatalog";
import { baselineIndex } from "../../infra/paths";
import { baselineCompatibilityOf } from "../baselineCompatibility";
import { calibrationThresholdShifts, type CalibrationShift } from "./calibrationGate";
import { gateCalibrationProfile } from "../../domain/calibration";
import { BaselineSchemaError, IoError, ParseError } from "../../errors/errors";
import { RuleCompileError } from "../../port/RuleService";
import { StorageService, type BaselineIndex, type CurrentMetricsProjection, type IndexEntry } from "../../port/StorageService";
import { participatesInPopulation } from "../../domain/fileParticipation";
import { currentFileMetrics } from "../currentMetrics";
import { matchesStructuralPolicy, policiesForSubject, type StructuralPolicy } from "../../domain/structuralPolicy";
import type { P95Values } from "../../domain/crlState";

export interface GateAppOptions { report?: boolean; projection?: CurrentMetricsProjection }
export type GateUnavailableReason =
  | "languages_empty"
  | "missing_baseline_index"
  | "baseline_scope_incompatible"
  /** 语言形状契约（§6/Q2）：baseline 记录的 `shapesFingerprint` 与当前声明不一致。 */
  | "baseline_shapes_incompatible"
  | "missing_snapshot_identity"
  | "metric_contract_incompatible"
  | "unsupported_gate_metric"
  | "missing_max_function_branch"
  | "missing_metric_language"
  | "unconfigured_language_policy"
  | "ambiguous_structural_policy"
  | "policy_calibration_missing"
  | "execution_failed";
export type GateDiagnosticCategory = "configuration" | "baseline" | "io" | "parser" | "rule" | "unexpected";
export interface GateDiagnostic {
  readonly category: GateDiagnosticCategory;
  readonly operation: string;
  readonly message: string;
  readonly path?: string;
}
export interface GateAppOutput {
  readonly code: number;
  readonly verdict: GateVerdict | "UNAVAILABLE";
  /** Presentation-neutral inputs for the CLI gate report. */
  readonly report?: GateReportFacts;
  /** Stable reason for an unavailable gate; diagnostic details remain factual. */
  readonly unavailableReason?: GateUnavailableReason;
  /** Present only after the project scope/configuration was successfully resolved. */
  readonly analysisScopeFingerprint?: string;
  /** Number of explicit project rules evaluated by this gate run. */
  readonly configuredRules?: number;
  readonly evaluatedFiles?: number;
  /** Report-only threshold crossings caused by a changed P95 sample with unchanged local inputs. */
  readonly calibrationShifts?: readonly CalibrationShift[];
  /** 小样本校准保护（report-only，校准 2026-08-15）：生产文件 <50 的策略 P95 不稳定。 */
  readonly smallSamplePolicies?: readonly { id: string; files: number; calibration: "sealed" | "bootstrapped" }[];
  /** Controlled failure context for CLI and governance diagnostics; never a raw stack/cause. */
  readonly diagnostic?: GateDiagnostic;
}

// ── 纯函数：从指标收集到输出不依赖 I/O ──────────────────────

type FileMetric = GateFileMetric;

const collectMetric = (m: IndexEntry): FileMetric => ({
  path: m.path,
  language: m.language,
  branchCount: m.branchCount,
  weightedBranchTotal: m.weightedBranchTotal,
  topLevelWeightedBranch: m.topLevelWeightedBranch,
  nestingDepth: m.nestingDepth,
  alphaStruct: m.alphaStruct,
  loc: m.loc, declarationLoc: m.declarationLoc,
  passthroughCalls: m.passthroughCalls,
  maxFuncBranch: m.maxFuncBranch,
  maxFuncBranchOwner: m.maxFuncBranchOwner,
  externalPassthroughCalls: m.externalPassthroughCalls,
  connectedness: m.connectedness,
  singleCallSiteRatio: m.singleCallSiteRatio,
  localBurdenFingerprint: m.localBurdenFingerprint,
  previousLocalBurdenFingerprint: m.previousLocalBurdenFingerprint,
  fileKind: m.fileKind,
});

/** Gate 只可裁决当前 languages 覆盖的源码；历史分片不得越过扫描边界。 */
export const filterMetricsForScope = <T extends { path: string }>(metrics: readonly T[], scope: AnalysisScope): T[] =>
  metrics.filter((metric) => isPathInAnalysisScope(metric.path, scope));

/**
 * 该 gate 指标的当前 P95 口径（只有单函数分支有 P95；复合值如 `crl_local` 没有）。
 * 与 `max_func_branch` 的每文件口径同源，避免出现第二个取值定义。
 */
const p95OfGateMetric: Readonly<Record<string, (p95: P95Values) => number>> = {
  max_func_branch: (p95) => p95.branch,
};

/**
 * 报告「阈值 / 当前 P95」倍数与超阈文件数（report-only）。
 *
 * 超阈文件数**直接取 gate 自己的触发结果**（`gatePerFile(...).triggered`），而不是重新比较一遍
 * 原始指标：后者会忽略规则里的分类器条件（dogfood 实测：`domain max_func_branch > 5` 被算成
 * "全体生产文件 > 5" 的 28/358，而该规则只作用于 domain 类文件），并且是同一判据的第二份实现。
 * 只处理具备 P95 口径的 gate 指标；其余保持沉默，不用 0/猜测填充。
 */
const thresholdVisibilityOf = (
  policy: StructuralPolicy,
  selected: readonly GateFileMetric[],
  p95: P95Values,
  triggered: readonly GateTrigger[],
  observedP95?: P95Values,
): readonly GateThresholdFact[] => {
  const facts: GateThresholdFact[] = [];
  for (const rule of policy.rules) {
    for (const declared of numericGateThresholdsInCondition(rule.condition)) {
      if (!p95OfGateMetric[declared.metricId]) continue;
      const p95Value = p95OfGateMetric[declared.metricId]?.(p95);
      const ratio = p95Value !== undefined && p95Value > 0 ? declared.threshold / p95Value : undefined;
      // D5：同一阈值的"当前观察倍数"（与 sealed 倍数并列）——只报告，不参与裁决。
      const observedValue = observedP95 ? p95OfGateMetric[declared.metricId]?.(observedP95) : undefined;
      const observedRatio = observedValue !== undefined && observedValue > 0 ? declared.threshold / observedValue : undefined;
      facts.push({
        policyId: policy.id, rule: rule.name, metricId: declared.metricId,
        comparison: declared.comparison, threshold: declared.threshold,
        ...(p95Value !== undefined ? { p95: p95Value } : {}),
        ...(ratio !== undefined ? { ratio } : {}),
        ...(observedRatio !== undefined ? { observedRatio } : {}),
        // 触发即"该规则的完整条件成立"，因此天然包含分类器条件。
        overThresholdFiles: triggered.filter((entry) => entry.name === rule.name).length,
        evaluatedFiles: selected.length,
      });
    }
  }
  return facts;
};

/**
 * baseline 就绪判据现在来自**共享权威** `baselineCompatibility`（D-G8③）：此前这里是私有实现，
 * 而 `status`、`scriptFacts` 各有一份，导致"scope 不兼容"在不同命令下可见性不同。
 * 判据顺序与条件**逐条不变**（本次只做收敛，不改 gate 行为）。
 *
 * §6/Q2（2026-09-27）：同一权威现在**同时消费 shapes**。当前形状指纹来自**本次已加载的**
 * `GateConfig`（`loadGateConfigStrict` 已用唯一读取权威 `projectShapes` 校验并解析过它，
 * 见 `gateConfig.readGateConfig`）——此处不再读第二遍配置，避免同一事实两处读取。
 * 未声明 ⇒ `""` ⇒ 与旧 baseline 的"无字段"相等 ⇒ 现有项目判据逐条不变。
 * 形状声明**不可用**时 `loadGateConfigStrict` 已经拒绝整份配置（`invalid_language_shapes`
 * 由此前的 gate 配置错误路径表达），因此这里看到的指纹一定是可用的。
 */
const baselineReadiness = (index: BaselineIndex | null, config: GateConfig): GateUnavailableReason | undefined => {
  const compatibility = baselineCompatibilityOf(index, config.analysisScope.fingerprint, config.shapesFingerprint);
  return compatibility.compatible ? undefined : compatibility.reason;
};

const code = (v: string) => v === "BLOCK" ? 2 : v === "WARN" ? 1 : 0;
const summarizeCause = (cause: unknown): string => cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "unavailable";

export const gateDiagnosticFromError = (error: unknown): GateDiagnostic => {
  if (error instanceof GateConfigurationError) return { category: "configuration", operation: "load_config", path: error.path, message: error.reason };
  if (error instanceof BaselineSchemaError) return { category: "baseline", operation: "read_baseline", path: error.path, message: error.reason };
  if (error instanceof IoError) return { category: "io", operation: "read_or_write", path: error.path, message: summarizeCause(error.cause) };
  if (error instanceof ParseError) return { category: "parser", operation: "parse", path: error.path, message: summarizeCause(error.cause) };
  if (error instanceof RuleCompileError) return { category: "rule", operation: "compile_rule", message: error.message };
  return { category: "unexpected", operation: "evaluate_gate", message: summarizeCause(error) };
};

const unavailable = (unavailableReason: GateUnavailableReason, diagnostic?: GateDiagnostic): GateAppOutput => ({
  code: 3, verdict: "UNAVAILABLE", unavailableReason, diagnostic,
});

// ── 管道编排 ──────────────────────────────────────────────

export const gateApp = (opts: GateAppOptions = {}) =>
  Effect.gen(function* () {
    const storage = yield* StorageService;
    const config = yield* Effect.promise(loadGateConfigStrict);
    if (config.analysisScope.languages.length === 0) return unavailable("languages_empty", {
      category: "configuration", operation: "validate_scope", message: "languages is empty",
    });
    const index = yield* storage.readIndex();
    if (index === null) {
      return unavailable("missing_baseline_index", { category: "baseline", operation: "validate_baseline", message: "baseline index is missing", path: baselineIndex() });
    }
    const readiness = baselineReadiness(index, config);
    if (readiness) return unavailable(readiness, { category: "baseline", operation: "validate_baseline", message: readiness, path: baselineIndex() });
    const unsupported = unsupportedMetricRules(config.structuralPolicies.flatMap((policy) => policy.rules));
    if (unsupported.length > 0) {
      const detail = unsupported.map((rule) => `${rule.name}(${[...new Set(unsupportedCelVariablesInCondition(rule.condition))].join(",")})`).join(", ");
      return unavailable("unsupported_gate_metric", { category: "configuration", operation: "validate_rules", message: detail });
    }
    const metrics = (yield* currentFileMetrics(storage, opts.projection)).map(([, metric]) => collectMetric(metric));
    // 测试 finding 有独立策略；这里的 gate/report 只陈述生产代码裁决。
    const productionMetrics = filterMetricsForScope(
      metrics.filter((metric) => participatesInPopulation(metric.fileKind, "production-governance")),
      config.analysisScope,
    );
    if (productionMetrics.some((metric) => metric.maxFuncBranch === undefined)) {
      return unavailable("missing_max_function_branch", { category: "baseline", operation: "validate_metrics", message: "maxFuncBranch is missing" });
    }
    if (productionMetrics.some((metric) => metric.language === undefined)) {
      return unavailable("missing_metric_language", { category: "baseline", operation: "validate_language", message: "baseline entries lack parser-confirmed language; run a complete scan" });
    }
    const languageMetrics = productionMetrics as Array<FileMetric & { readonly language: string }>;
    const productionLanguages = languageMetrics.map((metric) => metric.language);
    if (!config.explicitStructuralPolicies && new Set(productionLanguages).size > 1) {
      return unavailable("unconfigured_language_policy", { category: "configuration", operation: "validate_structural_policies", message: "multiple production languages require explicit structural_policies" });
    }
    const unmatched = languageMetrics.filter((metric) => policiesForSubject(config.structuralPolicies, metric).length === 0);
    if (unmatched.length > 0) {
      return unavailable("unconfigured_language_policy", { category: "configuration", operation: "validate_structural_policies", message: `no structural policy for: ${unmatched.map((metric) => metric.path).join(", ")}` });
    }
    const ambiguous = languageMetrics.filter((metric) => policiesForSubject(config.structuralPolicies, metric).length > 1);
    if (ambiguous.length > 0) {
      return unavailable("ambiguous_structural_policy", { category: "configuration", operation: "validate_structural_policies", message: `multiple structural policies match: ${ambiguous.map((metric) => metric.path).join(", ")}` });
    }

    const triggered: GateTrigger[] = [];
    const policyFacts: { id: string; mode: "observe" | "enforce"; languages: readonly string[]; evaluatedFiles: number }[] = [];
    const thresholdFacts: GateThresholdFact[] = [];
    const calibrationShifts: CalibrationShift[] = [];
    const smallSamplePolicies: { id: string; files: number; calibration: "sealed" | "bootstrapped" }[] = [];
    let legacyReportP95: P95Values | undefined;
    let blocked = false;
    let warned = false;
    for (const policy of config.structuralPolicies) {
      const selected = languageMetrics.filter((metric) => matchesStructuralPolicy(policy, metric));
      if (selected.length === 0) continue;
      policyFacts.push({ id: policy.id, mode: policy.mode, languages: policy.languages, evaluatedFiles: selected.length });
      if (policy.mode === "observe") continue;
      const calibrationProfiles = config.explicitStructuralPolicies
        ? index.meta.policyCalibrations?.[policy.id]
        : index.meta.calibration;
      if (selected.length < 50) {
        smallSamplePolicies.push({
          id: policy.id, files: selected.length,
          calibration: calibrationProfiles?.gate ? "sealed" : "bootstrapped",
        });
      }
      const p95 = gateCalibrationProfile(calibrationProfiles)?.p95
        ?? (!config.explicitStructuralPolicies ? index.meta.p95 : undefined);
      if (!p95) {
        return unavailable("policy_calibration_missing", { category: "baseline", operation: "validate_policy_calibration", message: `policy ${policy.id} has no sealed calibration; run a complete scan` });
      }
      if (!config.explicitStructuralPolicies) legacyReportP95 = p95;
      const result = yield* gatePerFile(policy.rules, selected, config.pathEntries, { p95, weights: policy.crlStateWeights, mode: policy.mode });
      triggered.push(...result.triggered);
      blocked ||= result.verdict === "BLOCK";
      warned ||= result.verdict === "WARN";
      thresholdFacts.push(...thresholdVisibilityOf(policy, selected, p95, result.triggered, index.meta.p95));
      calibrationShifts.push(...(yield* calibrationThresholdShifts({
        profiles: calibrationProfiles, rules: policy.rules, metrics: selected,
        paths: config.pathEntries, weights: policy.crlStateWeights,
      })));
    }
    const result = { verdict: blocked ? "BLOCK" as const : warned ? "WARN" as const : "PASS" as const, triggered };
    return {
      code: code(result.verdict), verdict: result.verdict,
      report: gateReportFacts(result, productionMetrics, opts.report === true, legacyReportP95, config.crlStateWeights, policyFacts, thresholdFacts),
      configuredRules: config.structuralPolicies.flatMap((policy) => policy.rules).length, evaluatedFiles: productionMetrics.length,
      analysisScopeFingerprint: config.analysisScope.fingerprint,
      calibrationShifts,
      ...(smallSamplePolicies.length > 0 ? { smallSamplePolicies } : {}),
    };
  }).pipe(
    Effect.catchAll((error) => Effect.succeed(unavailable("execution_failed", gateDiagnosticFromError(error)))),
  );
