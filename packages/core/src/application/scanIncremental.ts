// 增量扫描（校准 2026-08-08）：per-file sha256 内容身份变更检测 + 只重算变更文件
// 覆盖面边界（2026-08-12 评估）：变更文件 + 其一级消费者重算；运行时图 inDegree
// 从 edges 重建（正确）；baseline entry.inDegree 对"未变更但入度变化"的文件保持
// 旧值——但 prefilter 只查询变更文件且多文件变更保守保留（symbolHygiene 2026-08-12），
// 该滞后无实际危害，属已知边界。
// 及其一级消费者。独立文件保持 scan.ts 的局部负担（CRL）在项目 P95 阈值内。
import { Effect } from "effect";
import { resolve } from "node:path";
import type { IndexEntry, StorageService, BaselineIndex } from "../port/StorageService";
import { ParserService } from "../port/ParserService";
import { projectRoot } from "../infra/paths";
import { contentHashesOf } from "../projectFiles";
import { buildDependencyGraphFromEdges, type ImplicitEdge } from "../domain/graph";
import { DEFAULT_ANALYSIS_CONCURRENCY } from "../infra/boundedConcurrency";
import { snapshotIdentity, normalizeBaselineSnapshot } from "../adapter/storage/BaselineGenerationValidation";
import { IoError } from "../errors/errors";
import { absolutePathKey } from "../infra/paths";

const norm = (p: string) => absolutePathKey(p);

export interface IncrementalScanResult {
  readonly asts: readonly import("../domain/ast").FileAst[];
  readonly reusedEntries: readonly IndexEntry[];
  readonly edges: ReadonlyMap<string, readonly string[]>;
  readonly deletedPaths: readonly string[];
}

/** 增量变更检测（纯函数，校准 2026-08-08）：per-file sha256 内容身份对比。
 *  - changed：hash 不同或新增（previous 无 hash 而 current 有）
 *  - deleted：previous 有 hash 而 current 缺失（文件被删除）
 *  key 由调用方统一（项目根相对路径——持久化共识）。 */
export const incrementalChangeSet = (
  previousHashes: ReadonlyMap<string, string | undefined>,
  currentHashes: ReadonlyMap<string, string>,
): { readonly changed: readonly string[]; readonly deleted: readonly string[] } => {
  const changed = [...currentHashes].filter(([path, hash]) => previousHashes.get(path) !== hash).map(([path]) => path);
  const deleted = [...previousHashes].filter(([path, hash]) => hash !== undefined && !currentHashes.has(path)).map(([path]) => path);
  return { changed, deleted };
};

/** 增量扫描准备：只 parse 变更文件 + 其一级消费者；未变更文件复用 baseline per-file
 *  metrics（内容等价——文件未变），图边从 baseline imports 重建（不 parse 全量）。
 *  无 per-file hash 基线 / 无变更返回 null（调用方退化全量或直接复用快照）。 */
export const prepareIncrementalScan = (
  parser: ParserService,
  previousEntries: readonly (readonly [string, IndexEntry])[],
  implicitDeps: readonly ImplicitEdge[] | undefined,
  paths: readonly string[],
): Effect.Effect<IncrementalScanResult | null, unknown, ParserService> =>
  Effect.gen(function* () {
    // 持久化一致：增量检测 key 用项目根相对路径（baseline 分片/imports 已存相对，
    // 多人协作下绝对路径不跨 checkout 一致——共识 2026-08-08）。
    const currentHashes = contentHashesOf(paths, projectRoot());
    const previousHashes = new Map(previousEntries.map(([entryPath, entry]) => [entryPath, entry.contentSha256]));
    // 首次增量：baseline 尚无 per-file 内容身份，无法判定变更 → 全量退化
    if (![...previousHashes.values()].some((hash) => hash !== undefined)) return null;
    const { changed, deleted } = incrementalChangeSet(previousHashes, currentHashes);
    const deletedRel = new Set(deleted);
    if (changed.length === 0 && deletedRel.size === 0) {
      // 无变更（校准 2026-08-08）：复用全部 previous 快照，parse 0 文件。
      // 此前返回 null 会导致调用方退化全量 parse——增量失效（用户质疑实锤）。
      const edges = new Map<string, string[]>();
      for (const [entryPath, entry] of previousEntries) edges.set(norm(resolve(projectRoot(), entryPath)), (entry.imports ?? []).map((dep) => norm(resolve(projectRoot(), dep))));
      return { asts: [], reusedEntries: previousEntries.map(([, entry]) => entry), edges, deletedPaths: [] };
    }
    // 反向索引：依赖路径（相对）→ 消费者（相对），从 baseline imports，无需 parse
    const reverseIndex = new Map<string, string[]>();
    for (const [entryPath, entry] of previousEntries) {
      for (const dep of entry.imports ?? []) {
        reverseIndex.set(dep, [...(reverseIndex.get(dep) ?? []), entryPath]);
      }
    }
    const toParseRel = [...new Set([...changed, ...[...changed, ...deletedRel].flatMap((path) => reverseIndex.get(path) ?? [])])];
    const toParseAbs = toParseRel.map((path) => resolve(projectRoot(), path));
    const toParseNorm = new Set(toParseRel);
    const asts = toParseAbs.length > 0
      ? yield* Effect.forEach(toParseAbs, (path) => parser.parse(path), { concurrency: DEFAULT_ANALYSIS_CONCURRENCY })
      : [];
    const reusedEntries = previousEntries
      .filter(([entryPath]) => !deletedRel.has(entryPath) && !toParseNorm.has(entryPath))
      .map(([, entry]) => entry);
    // 图边（内存态用绝对路径，不持久化）：复用文件用 baseline imports，重算文件用新 AST imports
    const edges = new Map<string, string[]>();
    for (const entry of reusedEntries) edges.set(norm(resolve(projectRoot(), entry.path)), (entry.imports ?? []).map((dep) => norm(resolve(projectRoot(), dep))));
    for (const ast of asts) edges.set(norm(ast.path), ast.imports.filter((ref) => ref.resolvedPath !== null).map((ref) => norm(ref.resolvedPath!)));
    return { asts, reusedEntries, edges, deletedPaths: [...deletedRel] };
  });

/** 从边映射重建图（增量专用，避免重复实现）。 */
export const incrementalGraph = (edges: ReadonlyMap<string, readonly string[]>, implicitDeps: readonly ImplicitEdge[] | undefined) =>
  buildDependencyGraphFromEdges(edges, implicitDeps);

/** 分片级发布（校准 2026-08-08）：增量有变更时只更新变更面分片 + index，
 *  不做整体 staging 复制（复制整个 active 是 500+ 分片 IO，Windows 30s+）。
 *  幂等：atomicWriteJsonIfChanged 内容不变不写；index 除 scanAt 外与上次一致；
 *  deleteFileMetrics 批量删已删除分片。整体非原子，恢复靠 per-file hash 对比。
 *  快照身份必须与读侧对称（normalize 后再算——内存 entry 未经 schema parse，
 *  字段缺失/顺序与磁盘分片不一致会导致 identity mismatch）。 */
export const publishIncrementalEntries = (
  storage: Pick<StorageService, "writeFileMetrics" | "deleteFileMetrics" | "writeCanonicalIndex">,
  asts: readonly import("../domain/ast").FileAst[],
  entries: readonly IndexEntry[],
  deletedPaths: readonly string[],
  index: BaselineIndex,
): Effect.Effect<void, IoError> => {
  const entriesByPath = new Map(entries.map((entry) => [norm(entry.path), entry]));
  return Effect.gen(function* () {
    for (const ast of asts) {
      const entry = entriesByPath.get(norm(ast.path));
      if (entry) yield* storage.writeFileMetrics(resolve(ast.path), entry);
    }
    if (deletedPaths.length > 0) {
      yield* storage.deleteFileMetrics(deletedPaths.map((path) => resolve(projectRoot(), path)));
    }
    const normalized = normalizeBaselineSnapshot({ entries, index });
    yield* storage.writeCanonicalIndex({ ...index, meta: { ...index.meta, snapshotSha256: snapshotIdentity(normalized) } });
  });
};
// touch
