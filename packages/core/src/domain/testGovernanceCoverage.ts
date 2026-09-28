/** Coverage is a statement about the analysis boundary, not about test quality. */
export type TestGovernanceCoverageStatus = "available" | "partial" | "unavailable" | "not_configured";
export type TestGovernanceCoverageReason =
  | "test_governance_not_configured"
  | "no_test_files_discovered"
  | "no_active_provider"
  | "test_files_missing_from_baseline"
  | "test_files_unrecognized"
  | "provider_collection_failed"
  /** D-G8③：baseline 记录的分析范围与当前配置不一致（provider 候选来自该范围，需完整 scan）。 */
  | "baseline_scope_incompatible"
  /**
   * 语言形状契约（2026-09-27 §6/Q2）：baseline 记录的 `shapesFingerprint` 与当前声明不一致
   * ——判断（哪些调用算弱断言）已按新声明改变，而 baseline 的结构事实仍是旧声明下采集的。
   * 与范围不兼容同构、同一处权威（`baselineCompatibility`）产出。
   */
  | "baseline_shapes_incompatible";

export interface TestGovernanceCoverage {
  readonly status: TestGovernanceCoverageStatus;
  readonly reasons: readonly TestGovernanceCoverageReason[];
  readonly testFiles: number;
  /** Current project test sources that have no baseline entry, so no provider fact was claimed. */
  readonly unbaselinedTestFiles: readonly string[];
  /** Test files for which a configured provider completed collection successfully. */
  readonly providerHandledTestFiles: readonly string[];
  readonly unrecognizedTestFiles: readonly string[];
  readonly failedTestFiles: readonly string[];
}

export interface TestGovernanceCoverageInput {
  readonly configured: boolean;
  readonly activeProviderCount: number;
  readonly testFiles: readonly string[];
  readonly unbaselinedTestFiles: readonly string[];
  readonly providerHandledTestFiles: readonly string[];
  readonly unrecognizedTestFiles: readonly string[];
  readonly failedTestFiles: readonly string[];
  /** D-G8③：baseline 的分析范围是否仍与当前配置一致（由共享权威 `baselineCompatibility` 判定）。
   *  缺省表示未判定（不声称不兼容）——不兼容会同时降级为 `partial` 并给出可执行原因。 */
  readonly baselineScopeCompatible?: boolean;
  /** §6/Q2：baseline 的形状身份是否仍与当前声明一致（同一权威判定）。缺省 = 未判定。 */
  readonly baselineShapesCompatible?: boolean;
}

type CoverageBase = Omit<TestGovernanceCoverage, "status" | "reasons">;
type CoverageAssessment = (input: TestGovernanceCoverageInput, base: CoverageBase) => TestGovernanceCoverage | undefined;

const sortedUnique = (paths: readonly string[]): readonly string[] => [...new Set(paths)].sort();

const baseOf = (input: TestGovernanceCoverageInput): CoverageBase => ({
  testFiles: input.testFiles.length,
  unbaselinedTestFiles: sortedUnique(input.unbaselinedTestFiles),
  providerHandledTestFiles: sortedUnique(input.providerHandledTestFiles),
  unrecognizedTestFiles: sortedUnique(input.unrecognizedTestFiles),
  failedTestFiles: sortedUnique(input.failedTestFiles),
});

const reasonsOf = (base: CoverageBase, input: TestGovernanceCoverageInput): readonly TestGovernanceCoverageReason[] => [
  ...(input.baselineScopeCompatible === false ? ["baseline_scope_incompatible" as const] : []),
  ...(input.baselineShapesCompatible === false ? ["baseline_shapes_incompatible" as const] : []),
  ...(base.unbaselinedTestFiles.length > 0 ? ["test_files_missing_from_baseline" as const] : []),
  ...(base.unrecognizedTestFiles.length > 0 ? ["test_files_unrecognized" as const] : []),
  ...(base.failedTestFiles.length > 0 ? ["provider_collection_failed" as const] : []),
];

const notConfigured: CoverageAssessment = (input, base) =>
  input.configured ? undefined : { status: "not_configured", reasons: ["test_governance_not_configured"], ...base };

const noTestFiles: CoverageAssessment = (input, base) =>
  input.testFiles.length > 0 ? undefined : { status: "unavailable", reasons: ["no_test_files_discovered"], ...base };

const noActiveProvider: CoverageAssessment = (input, base) =>
  input.activeProviderCount > 0 ? undefined : { status: "unavailable", reasons: ["no_active_provider"], ...base };

const noHandledTestFiles: CoverageAssessment = (input, base) =>
  base.providerHandledTestFiles.length > 0 ? undefined : { status: "unavailable", reasons: reasonsOf(base, input), ...base };

/**
 * D-G8③ + §6/Q2：范围或**形状身份**不兼容时 coverage 至少是 `partial`——provider 候选集来自
 * baseline 的范围，而判断（哪些调用算弱断言）来自形状声明；任一变了就意味着"这一轮采集的
 * 对象或口径可能不是当前声明的"。放在 `noHandledTestFiles` 之后：一个文件都没处理时，
 * `unavailable` 是更强也更准确的事实（原因里已含两种不兼容）。
 */
const staleBaselineIdentity: CoverageAssessment = (input, base) =>
  input.baselineScopeCompatible === false || input.baselineShapesCompatible === false
    ? { status: "partial", reasons: reasonsOf(base, input), ...base }
    : undefined;

const partialCoverage: CoverageAssessment = (input, base) =>
  base.unbaselinedTestFiles.length === 0 && base.unrecognizedTestFiles.length === 0 && base.failedTestFiles.length === 0
    ? undefined
    : { status: "partial", reasons: reasonsOf(base, input), ...base };

/** Do not infer coverage from a finding script or a zero finding count. */
export const assessTestGovernanceCoverage = (input: TestGovernanceCoverageInput): TestGovernanceCoverage => {
  const base = baseOf(input);
  const assessment = [notConfigured, noTestFiles, noActiveProvider, noHandledTestFiles, staleBaselineIdentity, partialCoverage]
    .map((evaluate) => evaluate(input, base))
    .find((result) => result !== undefined);
  return assessment ?? { status: "available", reasons: [], ...base };
};
