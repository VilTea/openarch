import { describe, expect, it } from "vitest";
import { scopedTestEvidence } from "../../src/commands/evidence";
import type { TestGovernanceReport } from "@openarch/core";

const report: Pick<TestGovernanceReport, "decision" | "collection"> = {
  collection: {
  providersRun: ["typescript-vitest"],
  providerCoverage: [{
    providerId: "typescript-vitest", status: "available", reasons: [],
    candidateTestFiles: ["a.test.ts", "b.test.ts"], unbaselinedTestFiles: [], providerHandledTestFiles: ["a.test.ts", "b.test.ts"], failedTestFiles: [],
  }],
  coverage: { status: "available", reasons: [], testFiles: 2, unbaselinedTestFiles: [], providerHandledTestFiles: ["a.test.ts", "b.test.ts"], unrecognizedTestFiles: [], failedTestFiles: [] },
  testFiles: 2, providerSummaries: [], testCaseSpans: { availability: "available", value: [] }, staticModuleAssociations: [], associationUnavailableTestFiles: [], unrecognizedTestFiles: [],
  },
  decision: {
    findings: [
      { source: "typescript-vitest", ruleId: "vitest.focused-test", kind: "focused_test", file: "a.test.ts", evidence: ["it.only"], confidence: "confirmed" },
      { source: "typescript-vitest", ruleId: "vitest.missing-known-assertion", kind: "missing_assertion", file: "b.test.ts", evidence: ["no expect"], confidence: "low" },
    ],
    triggered: [{ finding: { source: "typescript-vitest", ruleId: "vitest.focused-test", kind: "focused_test", file: "a.test.ts", evidence: ["it.only"], confidence: "confirmed" }, level: "block" }],
    errors: [], exempted: [],
  },
};

describe("scopedTestEvidence", () => {
  it("keeps a calibration observation within one provider and rule", () => {
    expect(scopedTestEvidence(report, {
      providerId: "typescript-vitest", ruleId: "vitest.focused-test", authorityId: "vitest-api",
    })).toEqual({ findingCount: 1, policyVerdict: "BLOCK" });
  });

  it("refuses incomplete provider results and unknown providers", () => {
    expect(() => scopedTestEvidence({ ...report, decision: { ...report.decision, errors: ["parser failed"] } }, {
      providerId: "typescript-vitest", ruleId: "vitest.focused-test", authorityId: "vitest-api",
    })).toThrow("incomplete provider result");
    expect(() => scopedTestEvidence(report, {
      providerId: "unknown", ruleId: "vitest.focused-test", authorityId: "vitest-api",
    })).toThrow("provider was not run");
  });

  it("refuses zero findings from a provider without complete scope", () => {
    expect(() => scopedTestEvidence({ ...report, collection: { ...report.collection, providerCoverage: [{
      ...report.collection.providerCoverage[0], status: "not_applicable", reasons: ["provider_not_applicable"], candidateTestFiles: [], providerHandledTestFiles: [],
    }] } }, {
      providerId: "typescript-vitest", ruleId: "vitest.focused-test", authorityId: "vitest-api",
    })).toThrow("provider coverage is not_applicable");
  });
});
