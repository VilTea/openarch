import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classifyFileKind, classifyFileKindWithPolicy, evaluateTestPolicy, type TestFinding } from "../../src/domain/testGovernance";
import { assessTestGovernanceCoverage } from "../../src/domain/testGovernanceCoverage";
import { assessTestProviderCoverage } from "../../src/domain/testProviderCoverage";
import { summarizeTestFacts } from "../../src/domain/testFacts";

describe("classifyFileKind", () => {
  it("uses portable default conventions while keeping generated files separate", () => {
    expect(classifyFileKind("packages/core/src/domain/alpha.ts")).toBe("production");
    expect(classifyFileKind("packages/core/__tests__/domain/alpha.test.ts")).toBe("test");
    expect(classifyFileKind("src/services/order.spec.py")).toBe("test");
    expect(classifyFileKind("services/coordination/internal/evidence/evidence_test.go")).toBe("test");
    expect(classifyFileKind("integration/PaymentIT.java")).toBe("test");
    expect(classifyFileKind("packages/core/dist/index.d.ts")).toBe("generated");
  });

  it("applies project-provided auxiliary roles without hardcoding a directory convention", () => {
    expect(classifyFileKindWithPolicy("samples/catalog/input.ts", [{ pattern: "samples/**", kind: "auxiliary" }])).toBe("auxiliary");
    expect(classifyFileKindWithPolicy("src/catalog/input.ts", [{ pattern: "samples/**", kind: "auxiliary" }])).toBe("production");
  });

  it("interprets project rules against project-relative paths even when runtime passes absolute paths", () => {
    const root = resolve(tmpdir(), "openarch-demo");
    expect(classifyFileKindWithPolicy(
      join(root, "fixtures", "sample", "input.ts"),
      [{ pattern: "fixtures/**", kind: "auxiliary" }],
      { projectRoot: root },
    )).toBe("auxiliary");
  });
});

describe("evaluateTestPolicy", () => {
  const focused: TestFinding = {
    ruleId: "vitest.focused-test", kind: "focused_test", file: "a.test.ts", evidence: ["it.only"],
    confidence: "confirmed", source: "typescript-vitest",
  };

  it("maps provider facts through the project policy instead of provider severity", () => {
    const result = evaluateTestPolicy([focused], { rules: { focused_test: "block" } });
    expect(result.verdict).toBe("BLOCK");
    expect(result.triggered[0].level).toBe("block");
  });

  it("honours only non-expired, scoped exemptions", () => {
    const result = evaluateTestPolicy([focused], {
      rules: { focused_test: "block" },
      exemptions: [{ ruleId: "vitest.focused-test", file: "a.test.ts", reason: "incident", owner: "team", expires: "2026-07-12T00:00:00Z" }],
    }, new Date("2026-07-11T00:00:00Z"));
    expect(result.verdict).toBe("PASS");
    expect(result.exempted).toEqual([focused]);
  });
});

describe("assessTestGovernanceCoverage", () => {
  const testFiles = ["tests/verify.ts"];

  it("keeps an absent project declaration distinct from a policy PASS", () => {
    expect(assessTestGovernanceCoverage({
      configured: false, activeProviderCount: 0, testFiles,
      unbaselinedTestFiles: [], providerHandledTestFiles: [], unrecognizedTestFiles: testFiles, failedTestFiles: [],
    })).toMatchObject({ status: "not_configured", reasons: ["test_governance_not_configured"] });
  });

  it("reports unsupported custom test semantics as unavailable", () => {
    expect(assessTestGovernanceCoverage({
      configured: true, activeProviderCount: 1, testFiles,
      unbaselinedTestFiles: [], providerHandledTestFiles: [], unrecognizedTestFiles: testFiles, failedTestFiles: [],
    })).toMatchObject({ status: "unavailable", reasons: ["test_files_unrecognized"] });
  });

  it("reports mixed provider support as partial", () => {
    expect(assessTestGovernanceCoverage({
      configured: true, activeProviderCount: 1, testFiles: ["tests/a.test.ts", ...testFiles],
      unbaselinedTestFiles: [], providerHandledTestFiles: ["tests/a.test.ts"], unrecognizedTestFiles: testFiles, failedTestFiles: [],
    })).toMatchObject({ status: "partial", reasons: ["test_files_unrecognized"] });
  });

  it("reports available only after every known test file is handled", () => {
    expect(assessTestGovernanceCoverage({
      configured: true, activeProviderCount: 1, testFiles,
      unbaselinedTestFiles: [], providerHandledTestFiles: testFiles, unrecognizedTestFiles: [], failedTestFiles: [],
    })).toMatchObject({ status: "available", reasons: [] });
  });

  it("does not claim available coverage when a discovered test is absent from baseline", () => {
    expect(assessTestGovernanceCoverage({
      configured: true, activeProviderCount: 1, testFiles: ["tests/a.test.ts", "tests/new.test.ts"],
      unbaselinedTestFiles: ["tests/new.test.ts"], providerHandledTestFiles: ["tests/a.test.ts"], unrecognizedTestFiles: [], failedTestFiles: [],
    })).toMatchObject({ status: "partial", reasons: ["test_files_missing_from_baseline"] });
  });
});

describe("assessTestProviderCoverage", () => {
  const input = { providerId: "typescript-vitest", candidateTestFiles: ["tests/a.test.ts"], unbaselinedTestFiles: [], providerHandledTestFiles: ["tests/a.test.ts"], failedTestFiles: [] };

  it("keeps an inactive provider out of calibration scope", () => {
    expect(assessTestProviderCoverage({ ...input, candidateTestFiles: [], providerHandledTestFiles: [] }))
      .toMatchObject({ status: "not_applicable", reasons: ["provider_not_applicable"] });
  });

  it("requires every provider candidate to finish before evidence is available", () => {
    expect(assessTestProviderCoverage({ ...input, candidateTestFiles: ["tests/a.test.ts", "tests/b.test.ts"], failedTestFiles: ["tests/b.test.ts"] }))
      .toMatchObject({ status: "partial", reasons: ["provider_collection_failed"] });
    expect(assessTestProviderCoverage({ ...input, providerHandledTestFiles: [], failedTestFiles: ["tests/a.test.ts"] }))
      .toMatchObject({ status: "unavailable", reasons: ["provider_collection_failed"] });
  });

  it("does not export a provider scope with a matching test absent from baseline", () => {
    expect(assessTestProviderCoverage({ ...input, unbaselinedTestFiles: ["tests/new.test.ts"] }))
      .toMatchObject({ status: "partial", reasons: ["test_files_missing_from_baseline"] });
  });
});

describe("summarizeTestFacts", () => {
  it("keeps P95 observations within each provider instead of mixing framework semantics", () => {
    expect(summarizeTestFacts([
      { providerId: "go-testing", tests: [{ name: "TestA", loc: 10, assertionCount: 1, mockCount: 0, statuses: [], testBodyControlFlow: 1.3 }] },
      { providerId: "typescript-vitest", tests: [
        { name: "a", loc: 5, assertionCount: 2, mockCount: 1, statuses: [], testBodyControlFlow: 0.5 },
        { name: "b", loc: 15, assertionCount: 4, mockCount: 3, statuses: [], testBodyControlFlow: 1.5 },
      ] },
    ])).toEqual([
      { providerId: "go-testing", testFiles: 1, testCases: 1, p95: { loc: 10, assertionCount: 1, mockCount: 0, testBodyControlFlow: 1.3 } },
      { providerId: "typescript-vitest", testFiles: 1, testCases: 2, p95: { loc: 14.5, assertionCount: 3.9, mockCount: 2.9, testBodyControlFlow: 1.45 } },
    ]);
  });

  it("keeps control-flow P95 unavailable when a provider result lacks the v2 fact", () => {
    expect(summarizeTestFacts([{
      providerId: "typescript-vitest",
      tests: [
        { name: "known", loc: 3, assertionCount: 1, mockCount: 0, statuses: [], testBodyControlFlow: 1 },
        { name: "unavailable", loc: 4, assertionCount: 1, mockCount: 0, statuses: [] },
      ],
    }])).toEqual([{
      providerId: "typescript-vitest", testFiles: 1, testCases: 2,
      p95: { loc: 3.95, assertionCount: 1, mockCount: 0 },
    }]);
  });
});
