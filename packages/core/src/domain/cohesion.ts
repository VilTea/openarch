// packages/core/src/domain/cohesion.ts
// 公式6 子公式：Cohesion（文件内函数间调用密度）。
// 用于 CT（内聚性趋势）= Cohesion(t) - Cohesion(t₀)。
import type { FunctionInfo } from "./ast";

/**
 * Cohesion = 内部函数调用边数 / (f × (f-1) / 2)
 * - 调用边去重：A→B 不管调几次只算 1 条边
 * - f ≤ 1 → Cohesion = 1.0
 * - 值域 [0, 1]
 */
export const computeCohesion = (funcs: readonly FunctionInfo[]): number => {
  if (funcs.length <= 1) return 1.0;
  const names = new Set(funcs.map(f => f.name));
  const edges = new Set<string>(); // "caller→callee" 去重
  for (const f of funcs) {
    for (const callee of f.calls) {
      if (names.has(callee) && callee !== f.name) {
        edges.add(`${f.name}→${callee}`);
      }
    }
  }
  const maxEdges = funcs.length * (funcs.length - 1) / 2;
  return Math.min(1.0, edges.size / maxEdges);
};

/** 连通度——文件内函数是否在一个调用分量里。
 *  提取 helper 产生的层次调用（主→helper）算连通，不应被低内聚惩罚。
 *  返回值: 0~1（最大连通分量包含的函数数 / 总函数数）。≤1 函数 = 1.0。 */
export const computeConnectedness = (funcs: readonly FunctionInfo[]): number => {
  if (funcs.length <= 1) return 1.0;
  const names = new Set(funcs.map(f => f.name));
  // 无向邻接表（忽略方向——主调helper 和 helper被主调 都是"在一起"）
  const adj = new Map<string, Set<string>>();
  for (const f of funcs) adj.set(f.name, new Set());
  for (const f of funcs) {
    for (const callee of f.calls) {
      if (names.has(callee) && callee !== f.name) {
        adj.get(f.name)!.add(callee);
        adj.get(callee)!.add(f.name);
      }
    }
  }
  // BFS 从第一个函数找最大连通分量
  const visited = new Set<string>();
  const bfs = (start: string): number => {
    if (visited.has(start)) return 0;
    const queue = [start]; let size = 0;
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (visited.has(node)) continue;
      visited.add(node); size++;
      for (const neighbor of adj.get(node) ?? []) if (!visited.has(neighbor)) queue.push(neighbor);
    }
    return size;
  };
  let maxComponent = 0;
  for (const f of funcs) maxComponent = Math.max(maxComponent, bfs(f.name));
  return maxComponent / funcs.length;
};
