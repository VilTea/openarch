import { describe, expect, it } from "vitest";
import { computeCohesion, computeConnectedness, computeInternalCallShape } from "../../src/domain/cohesion";
import type { FunctionInfo } from "../../src/domain/ast";

const fn = (name: string, calls: readonly string[], callCounts?: Readonly<Record<string, number>>): FunctionInfo => ({
  name, branchCount: 0, calls, ...(callCounts ? { callCounts } : {}),
});

/**
 * 内部调用图形状的三个投影必须由同一权威产出（校准 2026-09-25）。
 *
 * 本用例固定的是**整合后的判读方式**，而不是一个新指标：
 * 机械分解的典型形态是「图仍然连通 + 单调用点助手占比很高」——
 * 只看 `connectedness`/`moduleShape` 会把一堆一次性助手读成健康。
 */
describe("内部调用图形状（cohesion 为唯一权威）", () => {
  it("老的两个投影与新权威逐值一致（无行为漂移）", () => {
    const funcs = [
      fn("main", ["a", "b"]),
      fn("a", ["b"]),
      fn("b", []),
      fn("orphan", []),
    ];
    const shape = computeInternalCallShape(funcs);
    expect(computeConnectedness(funcs)).toBe(shape.connectedness);
    expect(computeCohesion(funcs)).toBe(shape.cohesion);
  });

  it("「图很连通但全是单调用点助手」必须同时可见", () => {
    // main 调 a/b/c 各一次：三个助手在同一连通分量里 ⇒ 连通性满分、moduleShape 为 0，
    // 但三个助手都是"只用一次"⇒ 占比 1.0。这正是 gate 全绿而认知点上升的形态。
    const funcs = [
      fn("main", ["a", "b", "c"], { a: 1, b: 1, c: 1 }),
      fn("a", []), fn("b", []), fn("c", []),
    ];
    const shape = computeInternalCallShape(funcs);
    expect(shape.connectedness).toBe(1);
    expect(1 - shape.connectedness).toBe(0);
    expect(shape.calledFunctions).toBe(3);
    expect(shape.singleCallSiteFunctions).toBe(3);
    expect(shape.singleCallSiteRatio).toBe(1);
  });

  it("被调用两次的助手不算单调用点（按原始调用点计数，不是被调用者去重）", () => {
    const funcs = [
      fn("main", ["shared", "once"], { shared: 2, once: 1 }),
      fn("other", ["shared"], { shared: 1 }),
      fn("shared", []), fn("once", []),
    ];
    const shape = computeInternalCallShape(funcs);
    expect(shape.calledFunctions).toBe(2);
    expect(shape.singleCallSiteFunctions).toBe(1);
    expect(shape.singleCallSiteRatio).toBe(0.5);
  });

  it("从未被文件内调用的入口不计入分母（只被跨文件调用是不可见的）", () => {
    const funcs = [fn("entry", ["helper"], { helper: 1 }), fn("helper", []), fn("unused", [])];
    const shape = computeInternalCallShape(funcs);
    expect(shape.calledFunctions).toBe(1);
    expect(shape.singleCallSiteRatio).toBe(1);
  });

  it("文件内没有任何调用点时占比是 null，不是 0", () => {
    const shape = computeInternalCallShape([fn("a", []), fn("b", [])]);
    expect(shape.calledFunctions).toBe(0);
    expect(shape.singleCallSiteRatio).toBeNull();
  });

  it("单函数文件与空文件同样不可判定", () => {
    expect(computeInternalCallShape([]).singleCallSiteRatio).toBeNull();
    const single = computeInternalCallShape([fn("only", [])]);
    expect(single.connectedness).toBe(1);
    expect(single.singleCallSiteRatio).toBeNull();
  });

  it("缺少 callCounts 的旧事实按「每个 callee 至少一次」计（下界，不虚高）", () => {
    // 手工构造或不带调用点计数的来源：`main` 调 shared 两次但事实里没有计数 ⇒ 记为 1 次，
    // 于是 shared 看起来仍是单调用点。方向是**少报**单调用点，不会凭空制造告警。
    const funcs = [fn("main", ["shared"]), fn("shared", [])];
    const shape = computeInternalCallShape(funcs);
    expect(shape.singleCallSiteFunctions).toBe(1);
    expect(shape.singleCallSiteRatio).toBe(1);
  });
});
