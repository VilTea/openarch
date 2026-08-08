import { describe, it, expect } from "vitest";
import { computeIPush } from "../../src/domain/i-push";

describe("computeIPush", () => {
  it("3 因子（无 layerWeight）与旧公式一致", () => {
    const d = computeIPush([{ changeKind: "function_body", alphaStruct: 0.5, inDegree: 3 }]);
    // λ=10, α=0.5, log₂(4)=2, ω=1.0 → 10×0.5×2×1.0 = 10
    expect(d).toBeCloseTo(10, 1);
  });

  it("layerWeight 缺省退化", () => {
    const d = computeIPush([{ changeKind: "function_body", alphaStruct: 0.5, inDegree: 3 }]);
    const dDefault = computeIPush([{ changeKind: "function_body", alphaStruct: 0.5, inDegree: 3, layerWeight: 1.0 }]);
    expect(d).toBe(dDefault);
  });

  it("ω_layer 放大：domain 1.3 倍", () => {
    const d1 = computeIPush([{ changeKind: "function_sig", alphaStruct: 0.6, inDegree: 2 }]);
    const d13 = computeIPush([{ changeKind: "function_sig", alphaStruct: 0.6, inDegree: 2, layerWeight: 1.3 }]);
    // λ=50, α=0.6, log₂(3)=1.585 → 50×0.6×1.585=47.55, ×1.3=61.8
    expect(d13 / d1).toBeCloseTo(1.3, 1);
  });

  it("ω_layer 缩小：parser 0.8 倍", () => {
    const d1 = computeIPush([{ changeKind: "branch_add", alphaStruct: 0.3, inDegree: 1 }]);
    const d08 = computeIPush([{ changeKind: "branch_add", alphaStruct: 0.3, inDegree: 1, layerWeight: 0.8 }]);
    // λ=5, α=0.3, log₂(2)=1 → 5×0.3×1=1.5, ×0.8=1.2
    expect(d08 / d1).toBeCloseTo(0.8, 1);
  });

  it("branch_add scales with the actual weighted branch delta", () => {
    const guard = computeIPush([{ changeKind: "branch_add", alphaStruct: 0.3, inDegree: 1, weightedBranchDelta: 0.3 }]);
    const full = computeIPush([{ changeKind: "branch_add", alphaStruct: 0.3, inDegree: 1, weightedBranchDelta: 1.0 }]);
    expect(guard / full).toBeCloseTo(0.3, 5);
  });

  it("多 delta 聚合——layerWeight 各文件独立", () => {
    const d = computeIPush([
      { changeKind: "function_body", alphaStruct: 0.5, inDegree: 1, layerWeight: 1.3 },
      { changeKind: "function_body", alphaStruct: 0.5, inDegree: 1, layerWeight: 0.8 },
    ]);
    // λ=10, α=0.5, log₂(2)=1: 10×0.5×1×1.3=6.5 + 10×0.5×1×0.8=4.0 = 10.5
    expect(d).toBeCloseTo(10.5, 1);
  });

  it("λ_joint 退化（缺省 1.0）与旧公式一致", () => {
    const d = computeIPush([{ changeKind: "function_body", alphaStruct: 0.5, inDegree: 3 }]);
    const dWithJoint = computeIPush([{ changeKind: "function_body", alphaStruct: 0.5, inDegree: 3, lambdaJoint: 1.0 }]);
    expect(d).toBe(dWithJoint);
  });

  it("λ_joint = γ_completion：全覆盖(0.5) vs 孤立变更(2.0)——4 倍差", () => {
    const d05 = computeIPush([{ changeKind: "function_sig", alphaStruct: 0.6, inDegree: 2, lambdaJoint: 0.5 }]);
    const d20 = computeIPush([{ changeKind: "function_sig", alphaStruct: 0.6, inDegree: 2, lambdaJoint: 2.0 }]);
    expect(d20 / d05).toBeCloseTo(4.0, 1);
  });
});
