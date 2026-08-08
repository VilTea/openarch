import { describe, expect, it } from "vitest";
import { computeCRLState, computeCRLStateBreakdown, type P95Values } from "../../src/domain/crlState";

const p95: P95Values = {
  branch: 10, nesting: 10, loc: 10, alpha: 1,
  oneMinusConnectedness: 0.5, externalPassthrough: 10,
};

describe("CRL_state breakdown", () => {
  it("splits local burden, exposure, and module shape while preserving the composite value", () => {
    const input = {
      maxFuncBranch: 5, nestingDepth: 4, loc: 10, alphaStruct: 0.5,
      connectedness: 0.6, externalPassthroughCalls: 5,
    };

    const b = computeCRLStateBreakdown(input, p95);

    expect(b.localBurden).toBeCloseTo(0.405, 5);
    expect(b.exposure).toBe(0.5);
    expect(b.moduleShape).toBeCloseTo(0.4, 5);
    expect(b.components.alpha).toBeCloseTo(0.075, 5);
    expect(b.components.disconnectedness).toBeCloseTo(0.12, 5);
    expect(b.composite).toBeCloseTo(0.6, 5);
    expect(computeCRLState(input, p95)).toBeCloseTo(b.composite, 5);
  });

  it("keeps a zero P95 disconnectedness safe", () => {
    const b = computeCRLStateBreakdown({
      nestingDepth: 0, alphaStruct: 0, connectedness: 0.4,
    }, { ...p95, oneMinusConnectedness: 0 });

    expect(b.components.disconnectedness).toBe(0);
    expect(b.moduleShape).toBeCloseTo(0.6, 5);
  });
});
