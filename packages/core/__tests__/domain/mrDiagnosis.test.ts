import { describe, expect, it } from "vitest";
import { computeMRDiagnosis } from "../../src/domain/mrDiagnosis";
import { DEFAULT_CRL_STATE_WEIGHTS, type P95Values } from "../../src/domain/crlState";

const p95: P95Values = {
  branch: 10, nesting: 10, loc: 100, alpha: 1,
  oneMinusConnectedness: 1, externalPassthrough: 10,
};

describe("computeMRDiagnosis", () => {
  it("uses CRL_state local metrics and keeps deterioration separate from improvement", () => {
    const diagnosis = computeMRDiagnosis({
      file: "src/example.ts",
      before: { maxFuncBranch: 4, nestingDepth: 3, loc: 20, externalPassthroughCalls: 4, alphaStruct: 0.2 },
      after: { maxFuncBranch: 3, nestingDepth: 4, loc: 40, externalPassthroughCalls: 4, alphaStruct: 0.5 },
      p95,
      weights: DEFAULT_CRL_STATE_WEIGHTS,
    });

    expect(diagnosis.scope).toBe("existing");
    expect(diagnosis.localBurden.metrics.branch.normalizedDelta).toBeCloseTo(-0.02, 5);
    expect(diagnosis.localBurden.metrics.nesting.normalizedDelta).toBeCloseTo(0.02, 5);
    expect(diagnosis.localBurden.metrics.loc.normalizedDelta).toBeCloseTo(0.03, 5);
    expect(diagnosis.localBurden.deterioration).toBeCloseTo(0.05, 5);
    expect(diagnosis.localBurden.improvement).toBeCloseTo(0.02, 5);
    expect(diagnosis.exposure.delta).toBeCloseTo(0.3, 5);
  });

  it("uses maxFuncBranch instead of file-wide branchCount", () => {
    const diagnosis = computeMRDiagnosis({
      file: "src/tools.ts",
      before: { branchCount: 20, maxFuncBranch: 3, alphaStruct: 0.1 },
      after: { branchCount: 24, maxFuncBranch: 3, alphaStruct: 0.1 },
      p95,
      weights: DEFAULT_CRL_STATE_WEIGHTS,
    });

    expect(diagnosis.localBurden.metrics.branch.delta).toBe(0);
    expect(diagnosis.localBurden.deterioration).toBe(0);
  });

  it("marks an introduced file as non-comparable instead of using zero as its baseline", () => {
    const diagnosis = computeMRDiagnosis({
      file: "src/new.ts",
      after: { maxFuncBranch: 2, nestingDepth: 1, loc: 20, externalPassthroughCalls: 1, alphaStruct: 0.1 },
      p95,
      weights: DEFAULT_CRL_STATE_WEIGHTS,
    });

    expect(diagnosis.scope).toBe("introduced");
    expect(diagnosis.beforeSource).toBe("introduced");
    expect(diagnosis.localBurden.metrics.loc).toMatchObject({ before: null, after: 20, delta: null });
    expect(diagnosis.localBurden.deterioration).toBe(0);
  });

  it("keeps an existing file unavailable when no structural before fact exists", () => {
    const diagnosis = computeMRDiagnosis({
      file: "src/legacy.py",
      beforeSource: "unavailable",
      after: { maxFuncBranch: 4, nestingDepth: 3, loc: 50, externalPassthroughCalls: 4, alphaStruct: 0.1 },
      p95,
      weights: DEFAULT_CRL_STATE_WEIGHTS,
    });

    expect(diagnosis.scope).toBe("existing_unavailable");
    expect(diagnosis.localBurden.metrics.branch).toMatchObject({ before: null, after: 4, delta: null });
    expect(diagnosis.localBurden.deterioration).toBe(0);
  });

  it("keeps raw deltas but declines a score when the baseline has no P95", () => {
    const diagnosis = computeMRDiagnosis({
      file: "src/legacy.ts",
      before: { maxFuncBranch: 1, alphaStruct: 0.1 },
      after: { maxFuncBranch: 3, alphaStruct: 0.2 },
      weights: DEFAULT_CRL_STATE_WEIGHTS,
    });

    expect(diagnosis.localBurden.metrics.branch.delta).toBe(2);
    expect(diagnosis.localBurden.metrics.branch.normalizedDelta).toBeNull();
    expect(diagnosis.localBurden.deterioration).toBe(0);
  });
});
