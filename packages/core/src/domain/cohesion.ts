// packages/core/src/domain/cohesion.ts
// 文件内**内部调用图形状**的唯一权威（校准 2026-09-25）。
//
// 同一张图（`StructuralFacts` 单次遍历产出的 `FunctionInfo.calls`/`callOccurrences`）有三个互补投影，
// 必须定义在一起、由同一次遍历产出，否则会被分开消费并得出互相矛盾的结论：
//
// - `cohesion`：内部调用边密度（公式6 的 CT 输入，历史保留）。
// - `connectedness`：最大连通分量占比 —— 回答"内部函数是否还在一起"。
// - `singleCallSiteRatio`：**单调用点助手占比** —— 回答"这些函数是真抽象还是机械分解"。
//
// 为什么后两者必须一起读：纯机械分解的典型形态是**高连通 + 高单调用点占比**——
// 每个助手都被主函数调用一次，全在同一调用分量里，`connectedness` 很好看、`moduleShape` 接近 0。
// 只看连通性会把"一堆一次性助手"判成健康，这正是历史缺陷（gate 全绿而私有方法 12→57）的机制。
import type { FunctionInfo } from "./ast";

/**
 * 内部调用图形状。`singleCallSiteRatio` 为 `null` 表示**不可判定**（文件内没有任何调用点），
 * 不得用 0 冒充——"没有可判定的助手"与"助手都用了多次"是两件事。
 */
export interface InternalCallShape {
  readonly connectedness: number;
  readonly cohesion: number;
  /** 分母：至少被文件内调用过一次的函数数（只被跨文件调用或从未被调用的入口不计入）。 */
  readonly calledFunctions: number;
  /** 分子：其中**恰好只有一个调用点**的函数数。 */
  readonly singleCallSiteFunctions: number;
  /** 分子 / 分母；`calledFunctions === 0` 时为 `null`。 */
  readonly singleCallSiteRatio: number | null;
}

/** 无向邻接表：忽略方向——"主调助手"与"助手被主调"都算在一起。 */
const adjacencyOf = (funcs: readonly FunctionInfo[]): Map<string, Set<string>> => {
  const names = new Set(funcs.map((f) => f.name));
  const adj = new Map<string, Set<string>>();
  for (const f of funcs) adj.set(f.name, new Set());
  for (const f of funcs) {
    for (const callee of f.calls) {
      if (!names.has(callee) || callee === f.name) continue;
      adj.get(f.name)!.add(callee);
      adj.get(callee)!.add(f.name);
    }
  }
  return adj;
};

/** 每个函数在文件内被调用几次（跨函数累加的**原始调用点**计数）。 */
const callSitesByCallee = (funcs: readonly FunctionInfo[]): Map<string, number> => {
  const sites = new Map<string, number>();
  for (const f of funcs) {
    for (const callee of f.calls) {
      // `callCounts` 缺失（旧调用方手工构造的 FunctionInfo）时按"每个 callee 至少一次"计，
      // 这是下界：只会让助手显得**更少**是单调用点，不会虚高误报。
      const count = f.callCounts?.[callee] ?? 1;
      sites.set(callee, (sites.get(callee) ?? 0) + count);
    }
  }
  return sites;
};

const maxComponentShare = (funcs: readonly FunctionInfo[], adj: Map<string, Set<string>>): number => {
  const visited = new Set<string>();
  const bfs = (start: string): number => {
    if (visited.has(start)) return 0;
    const queue = [start];
    let size = 0;
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (visited.has(node)) continue;
      visited.add(node);
      size++;
      for (const neighbor of adj.get(node) ?? []) if (!visited.has(neighbor)) queue.push(neighbor);
    }
    return size;
  };
  let maxComponent = 0;
  for (const f of funcs) maxComponent = Math.max(maxComponent, bfs(f.name));
  return maxComponent / funcs.length;
};

const cohesionOf = (funcs: readonly FunctionInfo[], adj: Map<string, Set<string>>): number => {
  const edges = new Set<string>();
  for (const [caller, callees] of adj) for (const callee of callees) edges.add([caller, callee].sort().join("\u0000"));
  return Math.min(1.0, edges.size / (funcs.length * (funcs.length - 1) / 2));
};

/**
 * 一次遍历产出全部形状投影。`computeCohesion` / `computeConnectedness` 都是它的投影，
 * 因此不存在"两个函数各自建一次邻接表"的重复实现。
 */
export const computeInternalCallShape = (funcs: readonly FunctionInfo[]): InternalCallShape => {
  if (funcs.length <= 1) {
    return { connectedness: 1.0, cohesion: 1.0, calledFunctions: 0, singleCallSiteFunctions: 0, singleCallSiteRatio: null };
  }
  const adj = adjacencyOf(funcs);
  const sites = callSitesByCallee(funcs);
  const own = new Set(funcs.map((f) => f.name));
  let called = 0;
  let singleCallSite = 0;
  for (const [callee, count] of sites) {
    // 只统计文件内真实存在的函数：调用外部符号不是"本文件的助手"。
    if (!own.has(callee) || count <= 0) continue;
    called += 1;
    if (count === 1) singleCallSite += 1;
  }
  return {
    connectedness: maxComponentShare(funcs, adj),
    cohesion: cohesionOf(funcs, adj),
    calledFunctions: called,
    singleCallSiteFunctions: singleCallSite,
    singleCallSiteRatio: called === 0 ? null : singleCallSite / called,
  };
};

/**
 * Cohesion = 内部函数调用边数 / (f × (f-1) / 2)
 * - 调用边去重：A→B 不管调几次只算 1 条边
 * - f ≤ 1 → Cohesion = 1.0
 * - 值域 [0, 1]
 */
export const computeCohesion = (funcs: readonly FunctionInfo[]): number => computeInternalCallShape(funcs).cohesion;

/** 连通度——文件内函数是否在一个调用分量里。
 *  提取 helper 产生的层次调用（主→helper）算连通，不应被低内聚惩罚。
 *  返回值: 0~1（最大连通分量包含的函数数 / 总函数数）。≤1 函数 = 1.0。 */
export const computeConnectedness = (funcs: readonly FunctionInfo[]): number => computeInternalCallShape(funcs).connectedness;
