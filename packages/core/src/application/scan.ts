// packages/core/src/application/scan.ts
import { Effect } from "effect";
import { ParserService } from "../port/ParserService";
import { StorageService, type BaselineIndex, type IndexEntry } from "../port/StorageService";
import { resolve } from "node:path";
import type { Language } from "../domain/ast";
import { buildDependencyGraph, buildDependencyGraphFromEdges, computeInDegrees, computeReverseEdges, type ImplicitEdge } from "../domain/graph";
import { reach } from "../domain/reach";
import { confidence } from "../domain/confidence";
import { alphaStruct } from "../domain/alpha";
import { projectRoot, toRelative, absolutePathKey } from "../infra/paths";
import { publishIncrementalEntries } from "./scanIncremental";
import { p95 } from "../domain/p95";
import { classifyFileKindWithPolicy, type FileKind } from "../domain/testGovernance";
import { weightedBranchTotalOf } from "../domain/branchMetrics";
import { createAnalysisScope, type AnalysisScope } from "../domain/analysisScope";
import { participatesInPopulation } from "../domain/fileParticipation";
import { METRIC_CONTRACT_VERSION } from "../domain/metricCatalog";
import type { GateCalibrationTransition } from "../domain/calibration";
import type { CRLStateWeights } from "../domain/crlState";
import { ScanProgressService, type ScanPhase, type ScanRunStatus } from "../port/ScanProgressService";
import { DEFAULT_ANALYSIS_CONCURRENCY } from "../infra/boundedConcurrency";
import { projectBaselineEntry } from "./baselineEntry";
import { withGovernanceWriteLock } from "./governance/writeLock";
import { contentHashesOf } from "../projectFiles";
import { prepareIncrementalScan } from "./scanIncremental";
import { computeEntries, projectLanguages } from "./scanEntries";
import { buildScanMeta } from "./scanMeta";
import { matchesStructuralPolicy, type StructuralPolicy } from "../domain/structuralPolicy";

/** 与 graph.ts map 一致的路径标准化（A1：统一 absolutePathKey，盘符/分隔符一致） */
const norm = (p: string) => absolutePathKey(p);

export interface ScanOptions {
  /** 项目可替换默认目录/文件名约定；core 不把任何测试框架固化为分类策略。 */
  readonly fileKindClassifier?: (path: string) => FileKind;
  readonly analysisScope?: AnalysisScope;
  readonly completeScope?: boolean;
  /** CLI passes the project normalisation weights so profile comparison can reject policy changes. */
  readonly calibrationWeights?: CRLStateWeights;
  /** Explicit policy populations receive independent durable P95 epochs. */
  readonly structuralPolicies?: readonly StructuralPolicy[];
  /** Full scans only: explicitly move the P95 denominator used by the gate. */
  readonly sealCalibration?: boolean;
  /** Content identity supplied by the caller that selected a complete source population. */
  readonly sourceSnapshotSha256?: string;
  /** Content identity of .openarch/config.yml (P2-1: config change forces full rebuild). */
  readonly configSnapshotSha256?: string;
  /** 增量扫描（校准 2026-08-08）：有 baseline 且 git 可用时只重算变更文件及其一级
   *  消费者，未变更文件复用既有 per-file metrics；图从 baseline imports 重建，
   *  不 parse 全量。`--rebuild`/无 baseline/无 git 时退化为全量重建。 */
  readonly incremental?: boolean;
}

export interface ScanResult {
  readonly nFiles: number;
  readonly calibrationTransition?: GateCalibrationTransition;
  readonly gateCalibrationId?: string;
}

export const scan = (paths: readonly string[], implicitDeps?: readonly ImplicitEdge[], options: ScanOptions = {}) =>
  Effect.gen(function* () {
    if (paths.length === 0) return { nFiles: 0 };  // 空路径不写 index，防止 nFiles=0 污染
    const parser = yield* ParserService;
    const storage = yield* StorageService;
    const progress = yield* ScanProgressService;
    return yield* withGovernanceWriteLock(
      process.env.OPENARCH_AGENT_ID ?? "scan",
      () => Effect.gen(function* () {
        const startedAt = new Date().toISOString();
        const publishProgress = (status: ScanRunStatus, phase: ScanPhase, completed: number, extra: { nFiles?: number; reason?: string } = {}) =>
          progress.write({ version: "1", status, phase, completed, total: paths.length, startedAt, updatedAt: new Date().toISOString(), ...extra });
        const failProgress = (error: unknown) => publishProgress("failed", phase, parsed, { reason: error instanceof Error ? error.message : String(error) })
          .pipe(Effect.zipRight(Effect.fail(error)));
        let parsed = 0;
        let phase: ScanPhase = "preparing";

    yield* publishProgress("running", "preparing", 0);

    // Provider test facts survive structural re-analysis, but publication waits for a complete snapshot.
    const previousEntries = yield* storage.listAllFileMetrics();
    const previousIndex = yield* storage.readIndex().pipe(Effect.catchAll(() => Effect.succeed(null)));
    const previousByPath = new Map(previousEntries);

    phase = "parsing";
    yield* publishProgress("running", "parsing", parsed);
    let asts: import("../domain/ast").FileAst[] = [];
    let reusedEntries: IndexEntry[] = [];
    let incrementalEdges = new Map<string, string[]>();
    let incrementalDeleted: readonly string[] = [];
    const incremental = (options.incremental ?? false) && previousEntries.length > 0;
    if (incremental) {
      const prepared = yield* prepareIncrementalScan(parser, previousEntries, implicitDeps, paths);
      if (prepared) {
        asts = [...prepared.asts];
        reusedEntries = [...prepared.reusedEntries];
        incrementalEdges = new Map<string, string[]>([...prepared.edges].map(([key, value]) => [key, [...value]]));
        incrementalDeleted = prepared.deletedPaths;
        parsed = asts.length;
        if (prepared.asts.length === 0 && prepared.deletedPaths.length === 0) {
          // 无变更（校准 2026-08-08）：显式短路，不写库。activeSnapshotMatches 依赖
          // meta identity（calibration/p95 浮点可能扰动），短路保证秒回；entries 复用
          // baseline 快照，index 沿用（scanAt 不刷新）。
          yield* publishProgress("completed", "publishing", 0);
          return { nFiles: prepared.reusedEntries.length, calibrationTransition: undefined, gateCalibrationId: previousIndex?.meta.calibration?.gate?.id };
        }
      } else {
        asts = yield* Effect.forEach(paths, (path) => parser.parse(path).pipe(Effect.tap(() => Effect.sync(() => { parsed += 1; })), Effect.tap(() => publishProgress("running", "parsing", parsed))), { concurrency: DEFAULT_ANALYSIS_CONCURRENCY }).pipe(Effect.catchAll(failProgress));
      }
    } else {
      asts = yield* Effect.forEach(paths, (path) => parser.parse(path).pipe(Effect.tap(() => Effect.sync(() => { parsed += 1; })), Effect.tap(() => publishProgress("running", "parsing", parsed))), { concurrency: DEFAULT_ANALYSIS_CONCURRENCY }).pipe(Effect.catchAll(failProgress));
    }
    phase = "assembling";
    yield* publishProgress("running", phase, parsed);
    const classify = options.fileKindClassifier ?? ((path: string) => classifyFileKindWithPolicy(path, options.analysisScope?.fileKindRules, { projectRoot: projectRoot() }));
    const fileKinds = new Map(asts.map((ast) => [ast.path, classify(ast.path)]));
    const productionAsts = asts.filter((ast) => participatesInPopulation(fileKinds.get(ast.path), "production-governance"));

    // 测试 import 是验证关系，不是生产架构边；不能抬高生产文件的 Reach/alpha。
    const graph = incremental
      ? buildDependencyGraphFromEdges(incrementalEdges, implicitDeps)
      : buildDependencyGraph(productionAsts, implicitDeps);
    const inDegrees = computeInDegrees(graph);
    const reverseGraph = computeReverseEdges(graph);  // blast radius: 谁依赖我（非我依赖谁）
    const nFiles = paths.length;
    // 增量：复用文件的 fileKind/语言从 baseline entry 取，补足 production/test 计数
    // （校验要求 entries 统计与 meta 一致，校准 2026-08-08）。
    const nProductionFiles = incremental
      ? reusedEntries.filter((entry) => (entry.fileKind ?? "production") === "production").length + productionAsts.length
      : productionAsts.length;
    const nTestFiles = incremental
      ? reusedEntries.filter((entry) => entry.fileKind === "test").length + asts.filter((ast) => fileKinds.get(ast.path) === "test").length
      : asts.filter((ast) => fileKinds.get(ast.path) === "test").length;
    const languages = projectLanguages(incremental, reusedEntries, asts);
    const scope = options.analysisScope ?? createAnalysisScope(languages);

    const benchmarkThreshold = 5000;
    const useMaxDepth = nFiles > benchmarkThreshold ? 3 : 5;
    const performanceMode = nFiles > benchmarkThreshold ? "reduced" as const : "normal" as const;

    const { entries, p95Inputs: computedP95 } = computeEntries(asts, fileKinds, inDegrees, reverseGraph, nProductionFiles, previousByPath, useMaxDepth, incremental, reusedEntries, paths);

    const p95Values = {
      branch: p95(computedP95.branch), nesting: p95(computedP95.nesting), loc: p95(computedP95.loc),
      alpha: p95(computedP95.alpha), oneMinusConnectedness: p95(computedP95.oneMinusConn), externalPassthrough: p95(computedP95.externalPassthrough),
    };
    const { meta, calibrationUpdate, ambiguousPolicyEntry } = buildScanMeta({
      entries, options, previousIndex, scope, p95Values,
      nFiles, nProductionFiles, nTestFiles, languages, useMaxDepth, performanceMode,
    });
    if (ambiguousPolicyEntry) {
      return yield* failProgress(new Error(`multiple structural policies match ${ambiguousPolicyEntry.path}`));
    }
    phase = "publishing";
    yield* publishProgress("running", phase, parsed);
    // 分片级发布（校准 2026-08-08）：增量有变更时只更新变更面分片 + index，
    // 不做整体 staging 复制（复制整个 active 是 500+ 分片 IO，Windows 30s+）。
    if (incremental) {
      const index = { version: "5.2", meta };
      yield* publishIncrementalEntries(storage, asts, entries, incrementalDeleted, index).pipe(Effect.catchAll(failProgress));
    } else {
      yield* storage.writeBaseline({ entries, index: { version: "5.2", meta } }).pipe(Effect.catchAll(failProgress));
    }
    // A complete scan supersedes every replaceable candidate overlay. It is
    // cleared only after the new generation has been published successfully.
    if (storage.clearPendingDiff) yield* storage.clearPendingDiff().pipe(Effect.catchAll(failProgress));

        yield* publishProgress("completed", phase, parsed, { nFiles });
        return { nFiles, calibrationTransition: calibrationUpdate.transition, gateCalibrationId: calibrationUpdate.state.gate?.id };
      }),
    );
  });
