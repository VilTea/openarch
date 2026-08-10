import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { buildDependencyGraph, buildDependencyGraphFromEdges, computeReverseEdges } from "../../src/domain/graph";
import type { FileAst } from "../../src/domain/ast";
import type { ImplicitEdge } from "../../src/domain/graph";
import { absolutePathKey } from "../../src/infra/paths";

// resolveTsPath returns absolute paths; tests simulate with resolve()
const mkAst = (path: string, deps: (string | null)[]): FileAst => ({
  path,
  language: "typescript",
  branchCount: 1,
  nestingDepth: 1,
  functionCount: 1,
  passthroughCalls: 0,
  imports: deps.map((p) => ({
    resolvedPath: p ? absolutePathKey(p) : null,  // 与实现同源（A1：统一 absolutePathKey）
    source: p ?? "external",
  })),
  functions: [],
});

const R = (p: string) => absolutePathKey(p);  // 与 graph.ts map 同源（A1：统一 absolutePathKey）

describe("buildDependencyGraph", () => {
  it("构建邻接表：A 依赖 B + C", () => {
    const asts = [mkAst("a.ts", ["b.ts", "c.ts"]), mkAst("b.ts", []), mkAst("c.ts", [])];
    const graph = buildDependencyGraph(asts);
    expect(graph.get(R("a.ts"))).toEqual([R("b.ts"), R("c.ts")]);
    expect(graph.get(R("b.ts"))).toEqual([]);
  });

  it("忽略外部依赖（resolvedPath = null）", () => {
    const asts = [mkAst("a.ts", ["b.ts", null]), mkAst("b.ts", [])];
    const graph = buildDependencyGraph(asts);
    expect(graph.get(R("a.ts"))).toEqual([R("b.ts")]);
  });

  it("未在 asts 中的节点不在图中", () => {
    const asts = [mkAst("a.ts", ["b.ts"])];
    const graph = buildDependencyGraph(asts);
    expect(graph.has(R("b.ts"))).toBe(false);
  });

  it("property: 所有已知路径在图中都有条目", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 10 }),
        (paths) => {
          const unique = [...new Set(paths)];
          const asts = unique.map((p) => mkAst(p, []));
          const graph = buildDependencyGraph(asts);
          for (const p of unique) {
            expect(graph.has(R(p))).toBe(true);
          }
        }
      )
    );
  });
});

describe("buildDependencyGraphFromEdges", () => {
  it("从缓存的边映射重建图：A→B→C", () => {
    const edges = new Map<string, readonly string[]>([
      [R("a.ts"), [R("b.ts")]],
      [R("b.ts"), [R("c.ts")]],
      [R("c.ts"), []],
    ]);
    const graph = buildDependencyGraphFromEdges(edges);
    expect(graph.get(R("a.ts"))).toEqual([R("b.ts")]);
    expect(graph.get(R("b.ts"))).toEqual([R("c.ts")]);
    expect(graph.get(R("c.ts"))).toEqual([]);
  });

  it("合并隐式边", () => {
    const edges = new Map<string, readonly string[]>([
      [R("a.ts"), []],
      [R("b.ts"), []],
    ]);
    const implicit: ImplicitEdge[] = [{ from: R("a.ts"), to: R("b.ts"), via: "kafka:topic", type: "message_queue" }];
    const graph = buildDependencyGraphFromEdges(edges, implicit);
    expect(graph.get(R("a.ts"))).toEqual([R("b.ts")]);
  });

  it("与 buildDependencyGraph(asts) 等价（同样边集产出同样图）", () => {
    const asts = [mkAst("a.ts", ["b.ts", "c.ts"]), mkAst("b.ts", ["c.ts"]), mkAst("c.ts", [])];
    const fromAsts = buildDependencyGraph(asts);

    // 用 asts 提取的 resolvedPath 构建边映射（模拟 baseline 缓存）
    const edges = new Map<string, readonly string[]>();
    for (const ast of asts) {
      const deps = ast.imports.map(r => r.resolvedPath).filter((p): p is string => p !== null);
      edges.set(R(ast.path), deps);
    }
    const fromEdges = buildDependencyGraphFromEdges(edges);

    expect([...fromEdges.keys()].sort()).toEqual([...fromAsts.keys()].sort());
    for (const key of fromAsts.keys()) {
      // normalize deps values（fromEdges 的 deps 来自 resolve() → 反斜杠；fromAsts 来自 map() → 正斜杠）
      const normalize = (p: string) => p.replace(/\\/g, "/");
      const edDeps = [...(fromEdges.get(key) ?? [])].map(normalize).sort();
      const astDeps = [...(fromAsts.get(key) ?? [])].map(normalize).sort();
      expect(edDeps).toEqual(astDeps);
    }
  });
});

describe("computeReverseEdges", () => {
  it("A→B→C: B 依赖 A, C 依赖 B", () => {
    const edges = new Map<string, readonly string[]>([
      [R("a.ts"), [R("b.ts")]],
      [R("b.ts"), [R("c.ts")]],
      [R("c.ts"), []],
    ]);
    const graph = buildDependencyGraphFromEdges(edges);
    const rev = computeReverseEdges(graph);
    // a 无反向边（没有文件 import it）
    expect(rev.get(R("a.ts"))!).toEqual([]);
    // b 被 a import
    expect(rev.get(R("b.ts"))!).toEqual([R("a.ts")]);
    // c 被 b import
    expect(rev.get(R("c.ts"))!).toEqual([R("b.ts")]);
  });

  it("多入度：C 被 A 和 B 同时依赖", () => {
    const edges = new Map<string, readonly string[]>([
      [R("a.ts"), [R("c.ts")]],
      [R("b.ts"), [R("c.ts")]],
      [R("c.ts"), []],
    ]);
    const rev = computeReverseEdges(buildDependencyGraphFromEdges(edges));
    expect([...(rev.get(R("c.ts"))!)].sort()).toEqual([R("a.ts"), R("b.ts")].sort());
  });
});
