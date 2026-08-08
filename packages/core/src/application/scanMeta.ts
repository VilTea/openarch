// scan 的校准与 index meta 组装（拆自 scan.ts——校准 2026-08-08）：
// 独立文件控制 scan.ts 的局部负担（文件级 loc）在项目 P95 阈值内。
import type { IndexEntry, BaselineIndex } from "../port/StorageService";
import type { AnalysisScope } from "../domain/analysisScope";
import { METRIC_CONTRACT_VERSION } from "../domain/metricCatalog";
import { p95 } from "../domain/p95";
import { createStructuralCalibrationProfile, nextStructuralCalibrationState, type NextStructuralCalibrationState, type StructuralCalibrationState } from "../domain/calibration";
import { DEFAULT_CRL_STATE_WEIGHTS, type P95Values, type CRLStateWeights } from "../domain/crlState";
import { participatesInPopulation } from "../domain/fileParticipation";
import { matchesStructuralPolicy, policiesForSubject, type StructuralPolicy, type StructuralPolicySubject } from "../domain/structuralPolicy";

/** scan 调用方传入的校准相关选项（避免与 scan.ts 循环依赖）。 */
interface ScanCalibrationOptions {
  readonly structuralPolicies?: readonly StructuralPolicy[];
  readonly sealCalibration?: boolean;
  readonly completeScope?: boolean;
  readonly sourceSnapshotSha256?: string;
  readonly calibrationWeights?: CRLStateWeights;
}

export const structuralPolicySubject = (entry: IndexEntry): StructuralPolicySubject | undefined =>
  entry.language === undefined ? undefined : { path: entry.path, language: entry.language };

/** 一次性算出 index meta + 校准推进 + 多策略歧义（scan 主函数瘦身，2026-08-08）。 */
export const buildScanMeta = (input: {
  readonly entries: readonly IndexEntry[];
  readonly options: ScanCalibrationOptions;
  readonly previousIndex: BaselineIndex | null;
  readonly scope: AnalysisScope;
  readonly p95Values: P95Values;
  readonly nFiles: number;
  readonly nProductionFiles: number;
  readonly nTestFiles: number;
  readonly languages: readonly string[];
  readonly useMaxDepth: number;
  readonly performanceMode: "normal" | "reduced";
}): {
  readonly meta: BaselineIndex["meta"];
  readonly calibrationUpdate: NextStructuralCalibrationState;
  readonly ambiguousPolicyEntry?: IndexEntry;
} => {
  const calibration = createStructuralCalibrationProfile({
    analysisScopeFingerprint: input.scope.fingerprint,
    metricContractVersion: METRIC_CONTRACT_VERSION,
    p95: input.p95Values,
    population: input.entries.filter((entry) => participatesInPopulation(entry.fileKind, "production-governance")).map((entry) => ({
      path: entry.path, maxFuncBranch: entry.maxFuncBranch, nestingDepth: entry.nestingDepth, loc: entry.loc,
      alphaStruct: entry.alphaStruct, connectedness: entry.connectedness, externalPassthroughCalls: entry.externalPassthroughCalls,
    })),
    weights: input.options.calibrationWeights ?? DEFAULT_CRL_STATE_WEIGHTS,
  });
  // A repeated scan must retain the prior comparison pair. Advancing previous
  // without a structural profile change would erase denominator-only shifts.
  const calibrationUpdate = nextStructuralCalibrationState({
    observed: calibration,
    previous: input.previousIndex?.meta.calibration,
    sealGate: input.options.sealCalibration,
  });
  const ambiguousPolicyEntry = input.entries.find((entry) => {
    const subject = structuralPolicySubject(entry);
    return subject !== undefined
      && participatesInPopulation(entry.fileKind, "production-governance")
      && policiesForSubject(input.options.structuralPolicies ?? [], subject).length > 1;
  });
  const policyCalibrations = computePolicyCalibrations(input.options, input.entries, input.scope, input.previousIndex);
  const meta = buildBaselineIndexMeta({
    nFiles: input.nFiles, nProductionFiles: input.nProductionFiles, nTestFiles: input.nTestFiles,
    languages: input.languages, useMaxDepth: input.useMaxDepth, performanceMode: input.performanceMode,
    p95Values: input.p95Values, scope: input.scope, calibrationUpdate, policyCalibrations, options: input.options,
  });
  return { meta, calibrationUpdate, ambiguousPolicyEntry };
};

const p95ForPopulation = (entries: readonly {
  readonly branchCount: number; readonly weightedBranchTotal?: number; readonly maxFuncBranch?: number;
  readonly nestingDepth: number; readonly loc?: number; readonly alphaStruct: number;
  readonly connectedness?: number; readonly externalPassthroughCalls?: number;
}[]) => ({
  branch: p95(entries.map((entry) => entry.maxFuncBranch ?? entry.weightedBranchTotal ?? entry.branchCount)),
  nesting: p95(entries.map((entry) => entry.nestingDepth)),
  loc: p95(entries.map((entry) => entry.loc ?? 0)),
  alpha: p95(entries.map((entry) => entry.alphaStruct)),
  oneMinusConnectedness: p95(entries.map((entry) => 1 - (entry.connectedness ?? 0))),
  externalPassthrough: p95(entries.map((entry) => entry.externalPassthroughCalls ?? 0)),
});

/** 独立策略人群的 P95 校准 epoch。 */
export const computePolicyCalibrations = (
  options: ScanCalibrationOptions,
  entries: readonly IndexEntry[],
  scope: AnalysisScope,
  previousIndex: BaselineIndex | null,
): Readonly<Record<string, StructuralCalibrationState>> => Object.fromEntries(
  (options.structuralPolicies ?? []).flatMap((policy) => {
    const population = entries.filter((entry) =>
      participatesInPopulation(entry.fileKind, "production-governance")
      && structuralPolicySubject(entry) !== undefined
      && matchesStructuralPolicy(policy, structuralPolicySubject(entry)!),
    );
    if (population.length === 0) return [];
    const observed = createStructuralCalibrationProfile({
      analysisScopeFingerprint: `${scope.fingerprint}:policy:${policy.id}`,
      metricContractVersion: METRIC_CONTRACT_VERSION,
      p95: p95ForPopulation(population),
      population,
      weights: policy.crlStateWeights,
    });
    const update = nextStructuralCalibrationState({
      observed,
      previous: previousIndex?.meta.policyCalibrations?.[policy.id],
      sealGate: options.sealCalibration,
    });
    return [[policy.id, update.state] as const];
  }),
);

/** baseline index meta 组装。 */
export const buildBaselineIndexMeta = (input: {
  readonly nFiles: number; readonly nProductionFiles: number; readonly nTestFiles: number; readonly languages: readonly string[];
  readonly useMaxDepth: number; readonly performanceMode: "normal" | "reduced"; readonly p95Values: unknown; readonly scope: AnalysisScope;
  readonly calibrationUpdate: unknown; readonly policyCalibrations: Readonly<Record<string, StructuralCalibrationState>>;
  readonly options: ScanCalibrationOptions;
}): BaselineIndex["meta"] => ({
  scanAt: new Date().toISOString(), nFiles: input.nFiles, nProductionFiles: input.nProductionFiles, nTestFiles: input.nTestFiles,
  languages: input.languages, maxDepthUsed: input.useMaxDepth, performanceMode: input.performanceMode, p95: input.p95Values as BaselineIndex["meta"]["p95"],
  analysisScope: { fingerprint: input.scope.fingerprint, complete: input.options.completeScope ?? true }, metricContractVersion: METRIC_CONTRACT_VERSION,
  calibration: (input.calibrationUpdate as { state: StructuralCalibrationState }).state,
  ...(Object.keys(input.policyCalibrations).length > 0 ? { policyCalibrations: input.policyCalibrations } : {}),
  ...((input.options.completeScope ?? true) && input.options.sourceSnapshotSha256 ? { sourceSnapshotSha256: input.options.sourceSnapshotSha256 } : {}),
});
