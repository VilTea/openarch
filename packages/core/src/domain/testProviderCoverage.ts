/** Provider coverage limits a calibration observation to test files that provider claimed and processed. */
export type TestProviderCoverageStatus = "available" | "partial" | "unavailable" | "not_applicable";
export type TestProviderCoverageReason = "provider_not_applicable" | "provider_collection_failed" | "test_files_missing_from_baseline";

export interface TestProviderCoverage {
  readonly providerId: string;
  readonly status: TestProviderCoverageStatus;
  readonly reasons: readonly TestProviderCoverageReason[];
  readonly candidateTestFiles: readonly string[];
  /** Current project test sources claimed by this provider but absent from the baseline. */
  readonly unbaselinedTestFiles: readonly string[];
  readonly providerHandledTestFiles: readonly string[];
  readonly failedTestFiles: readonly string[];
}

export interface TestProviderCoverageInput {
  readonly providerId: string;
  readonly candidateTestFiles: readonly string[];
  readonly unbaselinedTestFiles: readonly string[];
  readonly providerHandledTestFiles: readonly string[];
  readonly failedTestFiles: readonly string[];
}

type ProviderCoverageBase = Omit<TestProviderCoverage, "status" | "reasons">;
type ProviderCoverageAssessment = (base: ProviderCoverageBase) => TestProviderCoverage | undefined;

const sortedUnique = (paths: readonly string[]): readonly string[] => [...new Set(paths)].sort();

const baseOf = (input: TestProviderCoverageInput): ProviderCoverageBase => ({
  providerId: input.providerId,
  candidateTestFiles: sortedUnique(input.candidateTestFiles),
  unbaselinedTestFiles: sortedUnique(input.unbaselinedTestFiles),
  providerHandledTestFiles: sortedUnique(input.providerHandledTestFiles),
  failedTestFiles: sortedUnique(input.failedTestFiles),
});

const notApplicable: ProviderCoverageAssessment = (base) =>
  base.candidateTestFiles.length === 0 && base.unbaselinedTestFiles.length === 0
    ? { status: "not_applicable", reasons: ["provider_not_applicable"], ...base }
    : undefined;

const unavailable: ProviderCoverageAssessment = (base) =>
  base.providerHandledTestFiles.length === 0
    ? { status: "unavailable", reasons: providerReasons(base), ...base }
    : undefined;

const partial: ProviderCoverageAssessment = (base) =>
  base.failedTestFiles.length > 0 || base.unbaselinedTestFiles.length > 0
    ? { status: "partial", reasons: providerReasons(base), ...base }
    : undefined;

const providerReasons = (base: ProviderCoverageBase): readonly TestProviderCoverageReason[] => [
  ...(base.unbaselinedTestFiles.length > 0 ? ["test_files_missing_from_baseline" as const] : []),
  ...(base.failedTestFiles.length > 0 ? ["provider_collection_failed" as const] : []),
];

/** A zero finding count is exportable only when this provider processed its whole claimed scope. */
export const assessTestProviderCoverage = (input: TestProviderCoverageInput): TestProviderCoverage => {
  const base = baseOf(input);
  const assessment = [notApplicable, unavailable, partial]
    .map((evaluate) => evaluate(base))
    .find((result) => result !== undefined);
  return assessment ?? { status: "available", reasons: [], ...base };
};
