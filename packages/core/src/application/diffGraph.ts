// packages/core/src/application/diffGraph.ts
// diff 图重建——从 baseline 缓存 imports + 变更文件新 parse 合并成完整依赖图。
// 纯 Effect 函数，输入 asts + storage，输出图 + 反向图 + 变更集。
import { Effect } from "effect";
import { StorageService } from "../port/StorageService";
import { buildDependencyGraphFromEdges, computeInDegrees, computeReverseEdges, type ImplicitEdge } from "../domain/graph";
import type { FileAst } from "../domain/ast";
import { projectRoot, toAbsolute } from "../infra/paths";
import { classifyFileKindWithPolicy, type FileKindRule } from "../domain/testGovernance";
import { participatesInPopulation } from "../domain/fileParticipation";
import { currentFileMetrics } from "./currentMetrics";

export interface RebuiltGraph {
  readonly graph: ReturnType<typeof buildDependencyGraphFromEdges>;
  readonly inDegrees: ReadonlyMap<string, number>;
  readonly reverseEdges: ReadonlyMap<string, readonly string[]>;
  readonly changedSet: Set<string>;
}

/** 从 FileAst 提取已解析的依赖路径（转绝对，供图运算） */
const resolvedImportsAbs = (ast: FileAst): readonly string[] =>
  ast.imports.map(r => r.resolvedPath).filter((p): p is string => p !== null).map(toAbsolute);

/** 重建完整依赖图 + 反向图 + 变更集。
 *  baseline 存相对路径；toAbsolute 转回绝对（归一化）供图运算。
 *  变更文件用新 parse 的 imports 覆盖缓存。 */
export const rebuildGraph = (
  asts: readonly FileAst[],
  storage: StorageService,
  implicitDeps?: readonly ImplicitEdge[],
  fileKindRules: readonly FileKindRule[] = [],
) =>
  Effect.gen(function* () {
    const allMetrics = yield* currentFileMetrics(storage);
    const edges = new Map<string, string[]>();
    const cwd = projectRoot();
    for (const [_path, entry] of allMetrics) {
      if (!participatesInPopulation(entry.fileKind, "production-governance")) continue;
      edges.set(toAbsolute(entry.path), [...(entry.imports ?? []).map(toAbsolute)]);
    }
    // 变更文件用新 parse 的 imports 覆盖
    for (const ast of asts) {
      if (!participatesInPopulation(classifyFileKindWithPolicy(ast.path, fileKindRules, { projectRoot: cwd }), "production-governance")) continue;
      edges.set(toAbsolute(ast.path), [...resolvedImportsAbs(ast)]);
    }

    const graph = buildDependencyGraphFromEdges(edges, implicitDeps);
    const inDegrees = computeInDegrees(graph);
    const reverseEdges = computeReverseEdges(graph);
    const changedSet = new Set(asts
      .filter((ast) => participatesInPopulation(classifyFileKindWithPolicy(ast.path, fileKindRules, { projectRoot: cwd }), "production-governance"))
      .map((ast) => toAbsolute(ast.path)));

    return { graph, inDegrees, reverseEdges, changedSet } as RebuiltGraph;
  });
