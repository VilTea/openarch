import { describe, expect, it } from "vitest";
import {
  sameCalibrationPopulation,
  selectFacts,
  validateGovernanceFact,
  validatePolicyProjection,
  type CalibrationProfile,
  type GovernanceFact,
} from "../../src/domain/governance";

const fact = (id: string, domain: string, availability: "available" | "partial" | "unavailable" = "available"): GovernanceFact => ({ id, domain, availability });

describe("governance runtime contracts", () => {
  it("preserves partial and unavailable evidence instead of treating it as an empty fact", () => {
    expect(validateGovernanceFact({ id: "test-case-spans.v1", availability: "partial", reason: "custom runner is not supported" }))
      .toMatchObject({ availability: "partial" });
    expect(() => validateGovernanceFact({ id: "test-case-spans.v1", availability: "unavailable" }))
      .toThrow("requires a reason");
    expect(validateGovernanceFact({ id: "test-case-spans.v1", availability: "partial", value: [], reason: "one test file was not recognized" }))
      .toMatchObject({ availability: "partial", value: [] });
    expect(() => validateGovernanceFact({ id: "test-case-spans.v1", availability: "unavailable", value: [], reason: "provider missing" }))
      .toThrow("cannot expose a value");
  });

  it("allows only metrics and findings to enter a policy projection", () => {
    expect(validatePolicyProjection({
      policyId: "project.max-function-branch",
      subject: { kind: "metric", metricId: "max_func_branch" },
      action: "warn",
    })).toMatchObject({ action: "warn" });
    expect(() => validatePolicyProjection({
      policyId: "project.calibration",
      subject: { kind: "signal", signalId: "CALIBRATION_SHIFT" },
      action: "block",
    } as unknown as Parameters<typeof validatePolicyProjection>[0])).toThrow("metric or finding");
  });

  it("compares calibration populations separately from profile labels", () => {
    const profile: CalibrationProfile = {
      id: "first", analysisScopeFingerprint: "scope-v2:typescript", metricContractVersion: "metric-contract-v2",
      populationFingerprint: "population-a", source: "baseline",
    };
    expect(sameCalibrationPopulation(profile, { ...profile, id: "renamed" })).toBe(true);
    expect(sameCalibrationPopulation(profile, { ...profile, populationFingerprint: "population-b" })).toBe(false);
  });

  it("selects facts by domain or id with dedup when the two overlap", () => {
    const facts = [
      fact("architecture-policy.v1", "architecture-policy"),
      fact("architecture-policy.v2", "architecture-policy"),
      fact("test-governance.v1", "test-governance", "partial"),
      fact("anti-patterns.v1", "anti-patterns", "unavailable"),
    ];
    // 按域消费：自动包含域内全部事实（含后续新增的 v2，无需改消费方）
    expect(selectFacts(facts, { domains: ["architecture-policy"] }).map((f) => f.id)).toEqual(["architecture-policy.v1", "architecture-policy.v2"]);
    // 按具体 id 按需消费
    expect(selectFacts(facts, { factIds: ["test-governance.v1"] }).map((f) => f.id)).toEqual(["test-governance.v1"]);
    // 域 + id 重叠去重：architecture-policy.v1 同时被域覆盖和显式点名，只消费一次
    expect(selectFacts(facts, { domains: ["architecture-policy"], factIds: ["architecture-policy.v1", "anti-patterns.v1"] }).map((f) => f.id))
      .toEqual(["architecture-policy.v1", "architecture-policy.v2", "anti-patterns.v1"]);
    // 空选择：不消费任何事实
    expect(selectFacts(facts, {})).toEqual([]);
  });
});
