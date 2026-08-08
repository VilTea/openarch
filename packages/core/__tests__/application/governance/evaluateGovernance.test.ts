import { describe, expect, it } from "vitest";
import { assembleGovernanceEvaluation } from "../../../src/application/governance/evaluateGovernance";
import type { GovernanceDiagnosticsReport } from "../../../src/application/governance/governanceDiagnostics";

const report = (): GovernanceDiagnosticsReport => ({
  gate: {
    code: 0, lines: [], verdict: "PASS", configuredRules: 2, evaluatedFiles: 4, analysisScopeFingerprint: "scope-v2:typescript",
    calibrationShifts: [{ path: "src/stable.ts", gateLocalBurden: 0.4, observedLocalBurden: 0.6, gateRules: [], observedRules: ["local burden"] }],
  },
  review: { nFiles: 4, entries: [], top3: [], hasData: true },
  antiPatterns: {
    state: "available",
    value: {
      rulesRun: 1, errors: [], unavailable: [], sourcesRun: ["no-inline.mjs"], ruleFailures: [], pruning: [],
      hits: [{ ruleId: "no-inline", file: "src/a.ts", message: "inline", source: "no-inline.mjs", scope: "file" }],
    },
  },
  tests: {
    state: "available",
    value: {
      decision: { verdict: "BLOCK", errors: [], exempted: [],
      findings: [{ ruleId: "focused", kind: "focused_test", file: "src/a.test.ts", evidence: ["line 1"], confidence: "confirmed", source: "typescript-vitest", line: 1 }],
      triggered: [{ finding: { ruleId: "focused", kind: "focused_test", file: "src/a.test.ts", evidence: ["line 1"], confidence: "confirmed", source: "typescript-vitest", line: 1 }, level: "block" }] },
      collection: { coverage: {
        status: "partial", reasons: ["test_files_unrecognized"], testFiles: 1, unbaselinedTestFiles: [],
        providerHandledTestFiles: [], unrecognizedTestFiles: ["src/a.test.ts"], failedTestFiles: [],
      },
      providerCoverage: [], testFiles: 1, providersRun: ["typescript-vitest"], providerSummaries: [],
      testCaseSpans: { availability: "partial", value: [], reason: "unrecognized test" }, staticModuleAssociations: [], associationUnavailableTestFiles: [],
      unrecognizedTestFiles: ["src/a.test.ts"],
      }, execution: { runnersRun: [], executions: [] }, scripts: { scriptUnavailable: [], scriptPruning: [] },
    },
  },
});

describe("evaluateGovernance migration adapter", () => {
  it("projects existing producers without converting partial coverage into a clean fact", () => {
    const evaluation = assembleGovernanceEvaluation(report());
    expect(evaluation.snapshot.scope).toEqual({ availability: "available", value: { fingerprint: "scope-v2:typescript" } });
    expect(evaluation.snapshot.facts["test-governance"]).toMatchObject({ availability: "partial" });
    expect(evaluation.snapshot.facts["anti-patterns"]).toMatchObject({ availability: "available" });
    expect(evaluation.snapshot.facts["architecture-policy"]).toMatchObject({ availability: "available" });
    expect(evaluation.snapshot.facts["structure-review"]).toMatchObject({ availability: "available" });
    expect(evaluation.signals).toEqual(expect.arrayContaining([expect.objectContaining({ id: "TEST_GOVERNANCE_COVERAGE", state: "partial", domains: ["test-governance"] })]));
    expect(evaluation.signals).toEqual(expect.arrayContaining([expect.objectContaining({ id: "CALIBRATION_SHIFT:src/stable.ts", state: "observed", domains: ["architecture-policy"] })]));
    expect(evaluation.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "anti-pattern:no-inline.mjs:no-inline:src/a.ts", confidence: "medium", domains: ["anti-patterns"] }),
      expect.objectContaining({ id: "test:typescript-vitest:focused:src/a.test.ts::1", confidence: "high", domains: ["test-governance"] }),
    ]));
    expect(evaluation.policyProjections).toEqual([{
      policyId: "test-governance:focused_test",
      subject: { kind: "finding", findingId: "test:typescript-vitest:focused:src/a.test.ts::1" },
      action: "block",
    }]);
  });

  it("keeps unavailable collection as a signal instead of a gate projection", () => {
    const input = report();
    const evaluation = assembleGovernanceEvaluation({ ...input, antiPatterns: { state: "unavailable", reason: "parser missing" } });
    expect(evaluation.snapshot.facts["anti-patterns"]).toMatchObject({ availability: "unavailable", reason: "parser missing" });
    expect(evaluation.signals).toEqual(expect.arrayContaining([expect.objectContaining({ id: "ANTI_PATTERN_COLLECTION", state: "unavailable" })]));
    expect(evaluation.policyProjections.every((projection) => projection.subject.kind !== ("signal" as never))).toBe(true);
  });

  it("retains a controlled gate diagnostic on unavailable architecture evidence", () => {
    const input = report();
    const evaluation = assembleGovernanceEvaluation({
      ...input,
      gate: {
        code: 3, lines: [], verdict: "UNAVAILABLE",
        diagnostic: { category: "rule", operation: "compile_rule", message: "Unexpected character" },
      },
    });
    expect(evaluation.snapshot.facts["architecture-policy"]).toMatchObject({ availability: "unavailable", reason: "rule/compile_rule: Unexpected character" });
    expect(evaluation.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ARCHITECTURE_POLICY_COLLECTION", state: "unavailable", message: "rule/compile_rule: Unexpected character" }),
    ]));
    expect(evaluation.policyProjections.every((projection) => projection.subject.kind !== ("signal" as never))).toBe(true);
  });
});
