import { describe, expect, it } from "vitest";
import { renderTestCoverage, renderTestGovernanceReport, testGovernanceJsonValue } from "../../src/report/testReport";
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

describe("testGovernanceJsonValue", () => {
  it("projects the stable v1 machine contract with provider boundaries and suggestions", () => {
    const report = {
      decision: {
        verdict: "WARN",
        findings: [{ ruleId: "x", kind: "missing_assertion", file: "tests/a.test.ts", testName: "a", evidence: [], confidence: "low", source: "typescript-vitest" }],
        triggered: [{ level: "warn", finding: { kind: "missing_assertion", file: "tests/a.test.ts", testName: "a", confidence: "low" } }],
        exempted: [{ kind: "missing_assertion", file: "tests/b.test.ts", testName: "b", confidence: "low" }],
        errors: ["runner failed"],
      },
      collection: {
        coverage: { status: "partial", reasons: ["test_files_missing_from_baseline"], testFiles: 2, unbaselinedTestFiles: ["tests/new.test.ts"], providerHandledTestFiles: ["tests/a.test.ts"], unrecognizedTestFiles: [], failedTestFiles: [] },
        providerCoverage: [{ providerId: "typescript-vitest", status: "partial", reasons: ["test_files_missing_from_baseline"], candidateTestFiles: ["tests/a.test.ts", "tests/new.test.ts"], unbaselinedTestFiles: ["tests/new.test.ts"], providerHandledTestFiles: ["tests/a.test.ts"], failedTestFiles: [] }],
        testFiles: 2,
        providersRun: ["typescript-vitest"],
        providerSummaries: [{ providerId: "typescript-vitest", testFiles: 1, testCases: 2, p95: { loc: 10, assertionCount: 2, mockCount: 0, testBodyControlFlow: 1 } }],
        testCaseSpans: { availability: "partial", value: [], reason: "some files unhandled" },
        unrecognizedTestFiles: [],
        suggestedAdapters: { providers: ["typescript-vitest"], runners: ["node-test"] },
        staticModuleAssociations: [{ testFile: "tests/a.test.ts", association: { targetPath: "src/a.ts", confidence: "medium", testName: "a", symbol: "a" } }, { testFile: "tests/a.test.ts", association: { targetPath: "src/b.ts", confidence: "low", testName: "a", symbol: "b" } }],
        associationUnavailableTestFiles: ["tests/c.test.ts"],
      },
      execution: { runnersRun: ["node-test"], executions: [{ providerId: "node-test", execution: { passed: true, command: "node --test" } }] },
      scripts: { scriptUnavailable: ["rules/x.mjs: missing"], scriptPruning: [{ rule: "rules/x.mjs", inputFiles: 2, targetFiles: 1, candidateFiles: 1, records: 0 }] },
    } as unknown as TestGovernanceReport;

    const json = testGovernanceJsonValue(report);
    expect(json.schema).toBe("test-governance-json-v1");
    expect(json.verdict).toBe("WARN");
    expect(json.decision.errors).toEqual(["runner failed"]);
    expect(json.decision.triggered[0]).toEqual({ level: "warn", kind: "missing_assertion", file: "tests/a.test.ts", testName: "a" });
    expect(json.collection.coverage.unbaselinedTestFiles).toBe(1);
    expect(json.collection.providers[0]).toMatchObject({ providerId: "typescript-vitest", status: "partial", candidates: 2, handled: 1, missingBaseline: 1, failed: 0 });
    expect(json.collection.suggestedAdapters).toEqual({ providers: ["typescript-vitest"], runners: ["node-test"] });
    expect(json.collection.staticModuleAssociations).toEqual({ testFiles: 1, modules: 2, edges: 2, low: 1, medium: 1 });
    expect(json.execution.executions[0]).toEqual({ providerId: "node-test", passed: true, command: "node --test" });
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
