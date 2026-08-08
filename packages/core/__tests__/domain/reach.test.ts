import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { reach } from "../../src/domain/reach";

const graph = (edges: Record<string, string[]>) => new Map(Object.entries(edges));

describe("reach() 公式1", () => {
  it("孤立节点 reach = 1（含自身）", () => {
    expect(reach(graph({ a: [] }), "a")).toBe(1);
  });

  it("A→B→C 线性链 reach(A)=3", () => {
    expect(reach(graph({ a: ["b"], b: ["c"], c: [] }), "a")).toBe(3);
  });

  it("环不无限循环：A→B→A，reach(A)=2", () => {
    expect(reach(graph({ a: ["b"], b: ["a"] }), "a")).toBe(2);
  });

  it("maxDepth 截断：A→B→C→D，maxDepth=2 时 reach(A)=3", () => {
    const g = graph({ a: ["b"], b: ["c"], c: ["d"], d: [] });
    expect(reach(g, "a", 2)).toBe(3);
  });

  it("property：reach ∈ [1, 总节点数]", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1, maxLength: 3 }), { maxLength: 10 }), (nodes) => {
        const unique = [...new Set(nodes)];
        const g = new Map(unique.map((n) => [n, [] as string[]]));
        if (unique.length === 0) return;
        const r = reach(g, unique[0]);
        expect(r).toBeGreaterThanOrEqual(1);
        expect(r).toBeLessThanOrEqual(unique.length);
      })
    );
  });
});
