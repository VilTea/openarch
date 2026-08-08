import { describe, expect, it } from "vitest";
import { renderTestCoverage, renderTestGovernanceReport } from "../../src/report/testReport";
import type { TestGovernanceReport } from "@openarch/core";

describe("renderTestCoverage", () => {
  it("keeps unavailable coverage distinct from the policy verdict", () => {
    const lines = renderTestCoverage({
      status: "unavailable",
      reasons: ["test_files_unrecognized"],
      testFiles: 2,
      unbaselinedTestFiles: [],
      providerHandledTestFiles: [],
      unrecognizedTestFiles: ["tests/verify.ts", "tests/tui-harness.ts"],
      failedTestFiles: [],
    });

    expect(lines).toContain("- 覆盖状态: UNAVAILABLE");
    expect(lines).toContain("- 覆盖限制: test_files_unrecognized");
    expect(lines.join("\n")).not.toContain("PASS");
  });
});

describe("renderTestGovernanceReport", () => {
  it("exposes the test-illusion family and route without changing policy", () => {
    const report = {
      decision: {
        findings: [{ ruleId: "pytest.missing", kind: "missing_assertion", file: "tests/test_a.py", testName: "test_a", evidence: ["no assert"], confidence: "low", source: "python-pytest" }],
        triggered: [], exempted: [], errors: [],
      },
      collection: {
        coverage: { status: "available", reasons: [], testFiles: 1, unbaselinedTestFiles: [], providerHandledTestFiles: ["tests/test_a.py"], unrecognizedTestFiles: [], failedTestFiles: [] },
        providerCoverage: [], testFiles: 1, providersRun: ["python-pytest"], providerSummaries: [],
        testCaseSpans: { availability: "available", value: [] }, staticModuleAssociations: [], associationUnavailableTestFiles: [], unrecognizedTestFiles: [],
      },
      execution: { runnersRun: [], executions: [] }, scripts: { scriptUnavailable: [], scriptPruning: [] },
    } as unknown as TestGovernanceReport;
    const lines = renderTestGovernanceReport(report, ["--verbose"]);
    expect(lines).toContainEqual(expect.stringContaining("test-illusion"));
    expect(lines).toContainEqual(expect.stringContaining("missing_assertion"));
  });
});
