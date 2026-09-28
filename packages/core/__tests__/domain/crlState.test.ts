import { describe, expect, it } from "vitest";
import { computeCRLState, computeCRLStateBreakdown, localBurdenInputsOf, type P95Values } from "../../src/domain/crlState";

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

  it("uses implementation loc and the passthrough fallback through one shared normalizer", () => {
    const local = localBurdenInputsOf({
      nestingDepth: 2, loc: 30, declarationLoc: 12,
      externalPassthroughCalls: undefined, passthroughCalls: 7,
    });
    expect(local).toEqual({ maxFuncBranch: 0, nestingDepth: 2, implementationLoc: 18, externalPassthroughCalls: 7 });

    const b = computeCRLStateBreakdown({
      maxFuncBranch: 5, nestingDepth: 2, loc: 30, declarationLoc: 12, alphaStruct: 0.5,
      connectedness: 0.6, passthroughCalls: 7,
    }, p95);
    // loc 因子按 18/10，external 按 7/10，与 gate/review 同口径
    expect(b.components.loc).toBeCloseTo(0.15 * 1, 5);
    expect(b.components.externalPassthrough).toBeCloseTo(0.15 * 0.7, 5);
  });

  it("单调用点助手占比是伴读值：传递但不参与任何求和（不新增权重）", () => {
    const base = { maxFuncBranch: 5, nestingDepth: 4, loc: 10, alphaStruct: 0.5, connectedness: 0.6, externalPassthroughCalls: 5 };
    const without = computeCRLStateBreakdown(base, p95);
    const withRatio = computeCRLStateBreakdown({ ...base, singleCallSiteRatio: 0.81 }, p95);

    expect(withRatio.singleCallSiteRatio).toBeCloseTo(0.81, 5);
    // 红线：不是新的加权分量，也不改 P95 归一化。
    expect(withRatio.localBurden).toBe(without.localBurden);
    expect(withRatio.composite).toBe(without.composite);
    expect(withRatio.components).toEqual(without.components);
  });

  it("缺失该事实时是 null（不可判定），不是 0", () => {
    const b = computeCRLStateBreakdown({ nestingDepth: 0, alphaStruct: 0, connectedness: 1 }, p95);
    expect(b.singleCallSiteRatio).toBeNull();
  });
});
