// packages/core/src/domain/reach.ts
import type { DependencyGraph } from "./graph";

/**
 * 公式1：可达影响范围（design v5.2 §7.1）
 *   Reach(f) = |{ v | v ⇝ f, v ∈ V }|  — "谁受影响"
 *
 * BFS 沿边遍历。边的语义由调用方决定：
 *   - 传入正向图（import 边）：沿依赖下游走（f 影响了被依赖的模块）→ 下游可达
 *   - 传入反向图（被依赖的逆边）：沿消费者走（谁引用了 f）→ 上游 blast radius ✅
 *
 * 2026-07-09 修正：所有调用方改为传入反向图（blast radius）。
 * 之前用正向图计算的是"它依赖谁"，不是"谁会受它变更影响"。
 *
 * 受 maxDepth 截断（默认 5）。α_struct / I_push 基于此近似。 */
export const reach = (graph: DependencyGraph, from: string, maxDepth = 5): number => {
  const visited = new Set<string>([from]);
  let frontier: string[] = [from];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      const deps = graph.get(node) ?? [];
      for (const dep of deps) {
        if (!visited.has(dep)) {
          visited.add(dep);
          next.push(dep);
        }
      }
    }
    frontier = next;
  }
  return visited.size;
};
