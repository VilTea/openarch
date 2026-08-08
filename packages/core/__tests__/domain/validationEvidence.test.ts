import { describe, expect, it } from "vitest";
import { validateValidationEvidence, type ValidationEvidence } from "../../src/domain/validationEvidence";

const evidence: ValidationEvidence = {
  schemaVersion: "2", projectToken: "opaque-project-token", observedAt: "2026-07-11T00:00:00.000Z",
  window: { startedAt: "2026-07-10T00:00:00.000Z", endedAt: "2026-07-11T00:00:00.000Z" },
  openarchVersion: "0.1.0", languages: ["typescript"], provider: { id: "typescript-vitest", version: "1" },
  ruleId: "vitest.focused-test", authorityId: "vitest-api",
  findingCount: 2, policyVerdict: "WARN", confirmedFalsePositiveCount: 0, confirmedFalseNegativeCount: 0, evidenceLevel: "observed",
};

describe("ValidationEvidence", () => {
  it("accepts aggregate evidence without project artifacts", () => expect(validateValidationEvidence(evidence)).toEqual(evidence));
  it("rejects invalid time windows and negative counts", () => {
    expect(() => validateValidationEvidence({ ...evidence, window: { ...evidence.window, endedAt: "2026-07-09T00:00:00.000Z" } })).toThrow("starts after");
    expect(() => validateValidationEvidence({ ...evidence, findingCount: -1 })).toThrow("non-negative");
  });
  it("requires the explicit rule and authority calibration key", () => {
    expect(() => validateValidationEvidence({ ...evidence, ruleId: "" })).toThrow("stable provider");
    expect(() => validateValidationEvidence({ ...evidence, authorityId: "E:\\workspace\\project" })).toThrow("stable provider");
  });
});
