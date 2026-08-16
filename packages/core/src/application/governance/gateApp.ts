// packages/core/src/application/governance/gateApp.ts
// gate 命令——数据流管道。Effect.gen 编排 I/O 步骤，纯函数渲染。
import { Effect } from "effect";
import { gatePerFile, type GateVerdict } from "./gate";
import { loadGateConfigStrict, unsupportedMetricRules } from "./gateConfig";
import { gateReportFacts, type GateFileMetric, type GateReportFacts } from "./gateReport";
import { isPathInAnalysisScope, type AnalysisScope } from "../../domain/analysisScope";
import { METRIC_CONTRACT_VERSION, unsupportedCelVariablesInCondition } from "../../domain/metricCatalog";
import { baselineIndex } from "../../infra/paths";
import { calibrationThresholdShifts, type CalibrationShift } from "./calibrationGate";
import { gateCalibrationProfile } from "../../domain/calibration";
import { GateConfigurationError } from "./gateConfig";
import { BaselineSchemaError, IoError, ParseError } from "../../errors/errors";
import { RuleCompileError } from "../../port/RuleService";
import { StorageService, type BaselineIndex, type CurrentMetricsProjection, type IndexEntry } from "../../port/StorageService";
import { participatesInPopulation } from "../../domain/fileParticipation";
import { currentFileMetrics } from "../currentMetrics";
import { matchesStructuralPolicy, policiesForSubject } from "../../domain/structuralPolicy";
import type { P95Values } from "../../domain/crlState";

export interface GateAppOptions { report?: boolean; projection?: CurrentMetricsProjection }
export type GateUnavailableReason =
  | "languages_empty"
  | "missing_baseline_index"
  | "baseline_scope_incompatible"
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
  externalPassthroughCalls: m.externalPassthroughCalls,
  connectedness: m.connectedness,
  localBurdenFingerprint: m.localBurdenFingerprint,
  previousLocalBurdenFingerprint: m.previousLocalBurdenFingerprint,
  fileKind: m.fileKind,
});

/** Gate 只可裁决当前 languages 覆盖的源码；历史分片不得越过扫描边界。 */
export const filterMetricsForScope = <T extends { path: string }>(metrics: readonly T[], scope: AnalysisScope): T[] =>
  metrics.filter((metric) => isPathInAnalysisScope(metric.path, scope));

const baselineReadiness = (index: BaselineIndex | null, scope: AnalysisScope): GateUnavailableReason | undefined => {
  if (index === null) return "missing_baseline_index";
  if (index.meta.analysisScope?.fingerprint !== scope.fingerprint || index.meta.analysisScope?.complete !== true) return "baseline_scope_incompatible";
  if (!index.meta.snapshotSha256) return "missing_snapshot_identity";
  if (index.meta.metricContractVersion !== METRIC_CONTRACT_VERSION) return "metric_contract_incompatible";
  return undefined;
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
    const readiness = baselineReadiness(index, config.analysisScope);
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

    const triggered: { name: string; level: string; condition: string; file?: string }[] = [];
    const policyFacts: { id: string; mode: "observe" | "enforce"; languages: readonly string[]; evaluatedFiles: number }[] = [];
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
      const result = yield* gatePerFile(policy.rules, selected, config.pathEntries, { p95, weights: policy.crlStateWeights });
      triggered.push(...result.triggered);
      blocked ||= result.verdict === "BLOCK";
      warned ||= result.verdict === "WARN";
      calibrationShifts.push(...(yield* calibrationThresholdShifts({
        profiles: calibrationProfiles, rules: policy.rules, metrics: selected,
        paths: config.pathEntries, weights: policy.crlStateWeights,
      })));
    }
    const result = { verdict: blocked ? "BLOCK" as const : warned ? "WARN" as const : "PASS" as const, triggered };
    return {
      code: code(result.verdict), verdict: result.verdict,
      report: gateReportFacts(result, productionMetrics, opts.report === true, legacyReportP95, config.crlStateWeights, policyFacts),
      configuredRules: config.structuralPolicies.flatMap((policy) => policy.rules).length, evaluatedFiles: productionMetrics.length,
      analysisScopeFingerprint: config.analysisScope.fingerprint,
      calibrationShifts,
      ...(smallSamplePolicies.length > 0 ? { smallSamplePolicies } : {}),
    };
  }).pipe(
    Effect.catchAll((error) => Effect.succeed(unavailable("execution_failed", gateDiagnosticFromError(error)))),
  );
