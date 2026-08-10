// packages/core/src/domain/graph.ts
import type { FileAst } from "./ast";
import { absolutePathKey } from "../infra/paths";

export type DependencyGraph = ReadonlyMap<string, readonly string[]>;

/** 隐式依赖边——代码中没有 import 但运行时存在。
 *  例：消息队列（Producer→Queue→Consumer）、HTTP RPC、共享数据库表。 */
export interface ImplicitEdge {
  readonly from: string;   // 生产者/调用方（文件路径）
  readonly to: string;     // 消费者/被调方（文件路径）
  readonly via: string;    // 中介（kafka:topic / http://api / db:table）
  readonly type: "message_queue" | "http_rpc" | "shared_db" | "event_bus" | string;
}

/** 合并隐式边（from → to）到已建好的图。
 *  from/to 用 map() 标准化；两端须在 knownPaths 中才连边。 */
const addImplicitEdges = (
  graph: Map<string, string[]>,
  knownPaths: Set<string>,
  implicitDeps: readonly ImplicitEdge[] | undefined,
  map: (p: string) => string,
): void => {
  if (!implicitDeps) return;
  for (const edge of implicitDeps) {
    const from = map(edge.from);
    const to = map(edge.to);
    if (knownPaths.has(from) && knownPaths.has(to)) {
      const deps = graph.get(from);
      if (deps && !deps.includes(to)) deps.push(to);
      // 确保 to 也在图中（即使没有被 scan 到）
      if (!graph.has(to)) graph.set(to, []);
    }
  }
};

/** 从 FileAst[] 构建依赖图——import 边 + 隐式边合并。
 *  ast.path 可能是相对路径；ref.resolvedPath 是 resolveTsPath 返回的绝对路径。
 *  统一用 resolve(ast.path) 标准化为绝对路径后比较。
 *  basePath 可选：默认 "."（cwd），测试可注入任意目录（TD-09 纯函数化）。 */
export const buildDependencyGraph = (
  asts: readonly FileAst[],
  implicitDeps?: readonly ImplicitEdge[],
  basePath = ".",
): DependencyGraph => {
  const map = (p: string) => absolutePathKey(p, basePath); // 统一盘符/分隔符（A1：与 scanEntries norm 同 key，Windows 盘符大小写一致）
  const knownPaths = new Set(asts.map((a) => map(a.path)));
  const graph = new Map<string, string[]>();

  // 初始化所有文件的邻接列表
  for (const ast of asts) graph.set(map(ast.path), []);

  // 1. import 边（统一 normalize 分隔符，与 knownPaths 对齐）
  for (const ast of asts) {
    const deps = graph.get(map(ast.path))!;
    for (const ref of ast.imports) {
      if (ref.resolvedPath !== null) {
        const rp = map(ref.resolvedPath);
        if (knownPaths.has(rp)) deps.push(rp);
      }
    }
  }

  // 2. 隐式边
  addImplicitEdges(graph, knownPaths, implicitDeps, map);

  return graph;
};

/** 从缓存的边映射重建依赖图（纯函数，不依赖 FileAst/parser）。
 *  edges: 绝对路径 → 它依赖的绝对路径列表（来自 baseline per-file 的 imports 字段）。
 *  路径已标准化为绝对路径，不再 resolve()。diff 用此重建完整图，只 parse 变更文件。 */
export const buildDependencyGraphFromEdges = (
  edges: ReadonlyMap<string, readonly string[]>,
  implicitDeps?: readonly ImplicitEdge[],
): DependencyGraph => {
  const knownPaths = new Set<string>(edges.keys());
  const graph = new Map<string, string[]>();

  // 初始化邻接列表 + 复制显式边
  for (const [node, deps] of edges) graph.set(node, [...deps]);

  // 隐式边（map = identity，路径已是绝对路径）
  addImplicitEdges(graph, knownPaths, implicitDeps, (p) => p);

  return graph;
};

/** 反向图：计算每个节点的入度（被多少文件依赖） */
export const computeInDegrees = (graph: DependencyGraph): ReadonlyMap<string, number> => {
  const inDegree = new Map<string, number>();
  for (const node of graph.keys()) inDegree.set(node, 0);
  for (const deps of graph.values()) {
    for (const dep of deps) {
      inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1);
    }
  }
  return inDegree;
};

/** 反向邻接表：file → 所有依赖它的文件列表。
 *  从完整依赖图（正向边：node → deps）反向构建。
 *  λ_joint γ_completion 计算用（覆盖度：依赖方中有多少本次也改了）。 */
export const computeReverseEdges = (graph: DependencyGraph): ReadonlyMap<string, readonly string[]> => {
  const reverse = new Map<string, string[]>();
  for (const node of graph.keys()) reverse.set(node, []);
  for (const [node, deps] of graph) {
    for (const dep of deps) {
      const list = reverse.get(dep);
      if (list) list.push(node);
    }
  }
  return reverse;
};
