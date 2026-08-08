/** Coverage is a statement about the analysis boundary, not about test quality. */
export type TestGovernanceCoverageStatus = "available" | "partial" | "unavailable" | "not_configured";
export type TestGovernanceCoverageReason =
  | "test_governance_not_configured"
  | "no_test_files_discovered"
  | "no_active_provider"
  | "test_files_missing_from_baseline"
  | "test_files_unrecognized"
  | "provider_collection_failed";

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

const reasonsOf = (base: CoverageBase): readonly TestGovernanceCoverageReason[] => [
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

const noHandledTestFiles: CoverageAssessment = (_input, base) =>
  base.providerHandledTestFiles.length > 0 ? undefined : { status: "unavailable", reasons: reasonsOf(base), ...base };

const partialCoverage: CoverageAssessment = (_input, base) =>
  base.unbaselinedTestFiles.length === 0 && base.unrecognizedTestFiles.length === 0 && base.failedTestFiles.length === 0
    ? undefined
    : { status: "partial", reasons: reasonsOf(base), ...base };

/** Do not infer coverage from a finding script or a zero finding count. */
export const assessTestGovernanceCoverage = (input: TestGovernanceCoverageInput): TestGovernanceCoverage => {
  const base = baseOf(input);
  const assessment = [notConfigured, noTestFiles, noActiveProvider, noHandledTestFiles, partialCoverage]
    .map((evaluate) => evaluate(input, base))
    .find((result) => result !== undefined);
  return assessment ?? { status: "available", reasons: [], ...base };
};
