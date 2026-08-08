import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { confidence } from "../../src/domain/confidence";

describe("confidence() 公式2", () => {
  it("全透传（透传调用数=总节点数）= clamp 上界 1.0", () => {
    expect(confidence({ passthroughCalls: 10, weightedControlFlow: 0, structuralNodeEstimate: 10 })).toBe(1.0);
  });

  it("零透传零分支 = clamp 下界 0.2", () => {
    expect(confidence({ passthroughCalls: 0, weightedControlFlow: 0, structuralNodeEstimate: 10 })).toBe(0.2);
  });

  it("除零保护：structuralNodeEstimate=0 → clamp 下界", () => {
    expect(confidence({ passthroughCalls: 0, weightedControlFlow: 0, structuralNodeEstimate: 0 })).toBe(0.2);
  });

  it("加权控制流：5 透传 + 10 控制流 / 20 结构上下文 = (5+3)/20 = 0.4", () => {
    expect(confidence({ passthroughCalls: 5, weightedControlFlow: 10, structuralNodeEstimate: 20 })).toBeCloseTo(0.4, 5);
  });

  it("property: confidence ∈ [0.2, 1.0] for all valid inputs", () => {
    fc.assert(
      fc.property(
        fc.nat(1000),
        fc.nat(500),
        fc.nat(2000),
        (passthroughCalls, weightedControlFlow, structuralNodeEstimate) => {
          const c = confidence({ passthroughCalls, weightedControlFlow, structuralNodeEstimate });
          expect(c).toBeGreaterThanOrEqual(0.2);
          expect(c).toBeLessThanOrEqual(1.0);
        }
      )
    );
  });
});
