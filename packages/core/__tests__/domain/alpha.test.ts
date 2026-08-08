import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { alphaStruct } from "../../src/domain/alpha";

describe("alphaStruct() 公式3", () => {
  it("孤立节点 reach=1, conf=0.5, N=10 → 小正数", () => {
    const α = alphaStruct({ reach: 1, confidence: 0.5, nFiles: 10 });
    expect(α).toBeGreaterThan(0);
    expect(α).toBeLessThan(0.5);
  });

  it("hub 节点 reach=10, conf=1.0, N=10 → 接近 1.0", () => {
    const α = alphaStruct({ reach: 10, confidence: 1.0, nFiles: 10 });
    expect(α).toBeGreaterThan(0.9);
  });

  it("N=1 时除零保护：分母 log₂(2)=1", () => {
    const α = alphaStruct({ reach: 1, confidence: 1.0, nFiles: 1 });
    expect(α).toBeCloseTo(1.0, 5);
  });

  it("property：α_struct ∈ [0, 1] 对所有 reach/confidence/N", () => {
    fc.assert(
      fc.property(
        fc.nat(1000),
        fc.float({ min: Math.fround(0.2), max: 1, noNaN: true }),
        fc.integer({ min: 1, max: 10000 }),
        (reach, conf, nFiles) => {
          const α = alphaStruct({ reach, confidence: conf, nFiles });
          expect(α).toBeGreaterThanOrEqual(0);
          expect(α).toBeLessThanOrEqual(1);
        }
      )
    );
  });
});
