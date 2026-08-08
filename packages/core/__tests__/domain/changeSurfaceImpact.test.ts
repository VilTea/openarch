import { describe, expect, it } from "vitest";
import { computeChangeSurfaceImpact } from "../../src/domain/changeSurfaceImpact";

describe("computeChangeSurfaceImpact", () => {
  it("聚合多符号多消费者的贡献与 total", () => {
    const result = computeChangeSurfaceImpact({
      provenance: "symbol",
      changes: [
        { anchor: "service:PublicApi", kind: "interface_add_remove" },
        { anchor: "util:privateHelper", kind: "function_body" },
      ],
      consumersByAnchor: new Map([
        ["service:PublicApi", ["packages/app/src/consumer-a.ts", "packages/app/src/consumer-b.ts"]],
        ["util:privateHelper", ["packages/app/src/consumer-a.ts"]],
      ]),
      layerWeightOf: (file) => (file.includes("consumer-b") ? 2.0 : 1.0),
    });

    expect(result.provenance).toBe("symbol");
    expect(result.total).toBeCloseTo(100 * Math.log2(3) * 2.0 + 10 * Math.log2(2) * 1.0, 6);
    expect(result.contributions).toHaveLength(2);

    const api = result.contributions.find((c) => c.anchor === "service:PublicApi")!;
    expect(api.lambdaAst).toBe(100);
    expect(api.consumers).toEqual(["packages/app/src/consumer-a.ts", "packages/app/src/consumer-b.ts"]);
    expect(api.reachFactor).toBeCloseTo(Math.log2(3), 6);
    expect(api.layerWeight).toBe(2.0);
    expect(api.contribution).toBeCloseTo(100 * Math.log2(3) * 2.0, 6);

    const helper = result.contributions.find((c) => c.anchor === "util:privateHelper")!;
    expect(helper.layerWeight).toBe(1.0);
    expect(helper.contribution).toBeCloseTo(10, 6);
  });

  it("同文件多次引用去重为 1 个消费者", () => {
    const result = computeChangeSurfaceImpact({
      provenance: "symbol",
      changes: [{ anchor: "a:x", kind: "public_method_sig" }],
      consumersByAnchor: new Map([["a:x", ["c.ts", "c.ts", "d.ts"]]]),
      layerWeightOf: () => 1.0,
    });
    expect(result.contributions[0].consumers).toEqual(["c.ts", "d.ts"]);
    expect(result.contributions[0].reachFactor).toBeCloseTo(Math.log2(3), 6);
  });

  it("无消费者符号贡献为 0", () => {
    const result = computeChangeSurfaceImpact({
      provenance: "symbol",
      changes: [{ anchor: "a:orphan", kind: "function_sig" }],
      consumersByAnchor: new Map([["a:orphan", []]]),
      layerWeightOf: () => 1.0,
    });
    expect(result.contributions[0].consumers).toEqual([]);
    expect(result.contributions[0].reachFactor).toBe(0);
    expect(result.contributions[0].contribution).toBe(0);
    expect(result.total).toBe(0);
  });

  it("layerWeight 取消费者权重的 max", () => {
    const result = computeChangeSurfaceImpact({
      provenance: "symbol",
      changes: [{ anchor: "a:x", kind: "dependency_add" }],
      consumersByAnchor: new Map([["a:x", ["low.ts", "mid.ts", "high.ts"]]]),
      layerWeightOf: (file) => (file === "high.ts" ? 3.0 : file === "mid.ts" ? 1.5 : 0.5),
    });
    expect(result.contributions[0].layerWeight).toBe(3.0);
  });

  it("unconfirmedAnchors 标记静态上界非空但符号级 0 消费者的符号", () => {
    const result = computeChangeSurfaceImpact({
      provenance: "symbol",
      changes: [
        { anchor: "a:seen", kind: "function_sig" },
        { anchor: "a:unseen", kind: "function_sig" },
      ],
      consumersByAnchor: new Map([["a:seen", ["c.ts"]]]),
      unconfirmedAnchors: ["a:unseen"],
      layerWeightOf: () => 1.0,
    });
    expect(result.contributions.find((c) => c.anchor === "a:seen")!.unconfirmed).toBe(false);
    expect(result.contributions.find((c) => c.anchor === "a:unseen")!.unconfirmed).toBe(true);
  });

  it("空 changes 时 total 为 0", () => {
    const result = computeChangeSurfaceImpact({
      provenance: "symbol",
      changes: [],
      consumersByAnchor: new Map(),
      layerWeightOf: () => 1.0,
    });
    expect(result.total).toBe(0);
    expect(result.contributions).toEqual([]);
  });
});
