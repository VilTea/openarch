// packages/core/src/port/StorageService.ts
import { Context, Effect } from "effect";
import { BaselineSchemaError, IoError } from "../errors/errors";
import type { FileDelta, SemanticEvidence } from "../domain/crl";
import type { FileKind, TestMetrics } from "../domain/testGovernance";
import type { MRDiagnosis } from "../domain/mrDiagnosis";
import type { StructuralCalibrationState } from "../domain/calibration";
import type { HistoryCompactionResult } from "../domain/historyRetention";
import type { Language } from "../domain/ast";

/** 单文件指标（per-file JSON 内容） */
export interface IndexEntry {
  readonly path: string;                          // 权威绝对路径（自描述）
  /** Parser-confirmed language; structural policy populations must not infer it from path shape. */
  readonly language?: Language;
  readonly fileKind?: FileKind;                   // 缺省 production，兼容既有 baseline
  /** @deprecated 兼容旧 baseline；语义等同 weightedBranchTotal。 */
  readonly branchCount: number;
  readonly weightedBranchTotal?: number;
  readonly topLevelWeightedBranch?: number;
  readonly nestingDepth: number;
  readonly inDegree: number;
  readonly outDegree: number;
  readonly alphaStruct: number;
  readonly imports?: readonly string[];           // 依赖的 resolvedPath 列表
  /** Parser-confirmed public re-exports; evolution analysis excludes them from implementation edges. */
  readonly reexports?: readonly string[];
  readonly cohesion?: number;                      // 文件内函数间调用密度（公式6）
  readonly passthroughCalls?: number;               // 透传调用数（喂 Confidence + 存量 CRL）
  readonly loc?: number;                             // 文件行数（CRL_state 用）
  /** 声明行（类型/接口/结构体头 + 函数签名行）：CRL loc 因子按实现行口径排除（校准 2026-08-08）。 */
  readonly declarationLoc?: number;
  readonly maxFuncBranch?: number;                    // 单函数最大加权分支数（卫语句/case 可为小数）
  readonly externalPassthroughCalls?: number;          // 已确认的直接非本地调用；成员/动态调用不计入
  readonly connectedness?: number;                     // 函数连通度（提取helper不罚）
  /** 文件内容身份（sha256）：增量扫描变更检测基准（校准 2026-08-08）。 */
  readonly contentSha256?: string;
  /** Current and preceding raw crl_local inputs; hashes avoid storing a second metric snapshot. */
  readonly localBurdenFingerprint?: string;
  readonly previousLocalBurdenFingerprint?: string;
  readonly testMetrics?: TestMetrics;                  // provider 产出的版本化测试事实
}

/** 分片索引（仅 metadata——指标从 per-file JSON 读取，gate/review 通过 readdir 遍历目录获取）。
 *  不存 files 列表：该字段只被污染、不被消费。本 adapter 不做索引，Phase 3 可换 SQLite 策略。 */
export interface BaselineIndex {
  readonly version: string;
  readonly meta: {
    readonly scanAt: string;
    /** Content-addressed identity of entries + semantic scan metadata; excludes scanAt. */
    readonly snapshotSha256?: string;
    /** Content identity of the complete governed source population at scan time. */
    readonly sourceSnapshotSha256?: string;
    readonly nFiles: number;
    readonly nProductionFiles?: number;
    readonly nTestFiles?: number;
    readonly languages: readonly string[];
    readonly maxDepthUsed?: number;
    readonly performanceMode?: string;
    readonly analysisScope?: { readonly fingerprint: string; readonly complete: boolean };
    readonly metricContractVersion?: string;
    /** Observed P95 profiles plus the explicitly sealed profile used by the gate. */
    readonly calibration?: StructuralCalibrationState;
    /** Independent P95 epochs for explicitly configured structural policy populations. */
    readonly policyCalibrations?: Readonly<Record<string, StructuralCalibrationState>>;
    /** CRL_state P95 归一化基准（scan 时计算） */
    readonly p95?: {
      readonly branch: number; readonly nesting: number; readonly loc: number;
      readonly alpha: number; readonly oneMinusConnectedness: number; readonly externalPassthrough: number;
    };
  };
}

/** A complete scan generation. It must become visible as one coherent baseline. */
export interface BaselineSnapshot {
  readonly entries: readonly IndexEntry[];
  readonly index: BaselineIndex;
  /** 写库剪枝（校准 2026-08-08）：增量 scan 只覆盖这些分片，其余沿用 active 快照。 */
  readonly changedPaths?: readonly string[];
  /** 增量 scan 中已删除文件的分片路径（staging 复制 active 后移除）。 */
  readonly deletedPaths?: readonly string[];
}

export type CurrentMetricsProjection = "worktree" | "pending";

export interface StoredHistoryEntry {
  readonly timestamp: string;
  readonly entryId: string;
  readonly deltas: readonly FileDelta[];
  readonly diagnosis?: readonly MRDiagnosis[];
  readonly evidence?: readonly SemanticEvidence[];
}

/** Replaceable worktree candidate; only a matching staged snapshot may seal it into history. */
export interface PendingDiffEntry extends StoredHistoryEntry {
  readonly revisionKey: string;
  /** Identity of the complete generation from which baseMetrics were read. */
  readonly baselineSnapshotSha256?: string;
  /** Metrics from the sealed baseline before this worktree candidate first touched each file. */
  readonly baseMetrics: readonly PendingBaseMetric[];
  /** Replaceable after-metrics for the candidate projection; never part of the sealed baseline generation. */
  readonly overlayMetrics?: readonly IndexEntry[];
}

export interface PendingBaseMetric {
  readonly file: string;
  readonly entry: IndexEntry | null;
}

/** Port：持久化（仓储 + 端口适配器模式） */
export interface StorageService {
  /** Publishes a complete scan generation; readers must never observe a mixed snapshot. */
  readonly writeBaseline: (snapshot: BaselineSnapshot) => Effect.Effect<void, IoError>;
  readonly readIndex: () => Effect.Effect<BaselineIndex | null, IoError>;
  readonly writeIndex: (index: BaselineIndex) => Effect.Effect<void, IoError>;
  /** 增量 scan 的 canonical index 发布（校准 2026-08-08）：分片已逐个更新
   *  （writeFileMetrics/deleteFileMetrics）后，此方法更新 _index.json。
   *  与 writeIndex 的区别：writeIndex 只服务 candidate overlay（canonical 拒绝），
   *  本方法显式声明"canonical 快照的增量发布"——调用方（scan）保证分片集完整。 */
  readonly writeCanonicalIndex: (index: BaselineIndex) => Effect.Effect<void, IoError>;
  /** 写 per-file JSON（分片，原子 write-file-atomic） */
  readonly writeFileMetrics: (absPath: string, entry: IndexEntry) => Effect.Effect<void, IoError>;
  /** 删除已不属于当前项目源码快照的分片，防止中途删除文件留下孤立 baseline。 */
  readonly deleteFileMetrics: (paths: readonly string[]) => Effect.Effect<void, IoError>;
  /** 读 per-file JSON。路径不存在时返回 null */
  readonly readFileMetrics: (absPath: string) => Effect.Effect<IndexEntry | null, IoError>;
  /** 读全部 per-file（[权威path, entry][]）。diff 重建依赖图 + gate/review/record 统一用此，取代 readdir+反解 */
  readonly listAllFileMetrics: () => Effect.Effect<ReadonlyArray<readonly [string, IndexEntry]>, IoError>;
  /**
   * Read the current projection: the last complete scan generation plus a
   * fresh pending candidate whose source hashes still match the worktree.
   * Legacy in-memory adapters may omit this and callers fall back to the
   * complete baseline.
   */
  readonly listCurrentFileMetrics?: (projection?: CurrentMetricsProjection) => Effect.Effect<ReadonlyArray<readonly [string, IndexEntry]>, IoError>;
  /** 清空全部 per-file JSON（保留 _index.json）。scan 全量重建前调用，删除已不存在的过时 per-file */
  readonly clearFileMetrics: () => Effect.Effect<void, IoError>;
  // history
  /** diagnosis 是可选扩展；旧 history 保持可读，CRL replay 仍只消费 deltaI。 */
  readonly writeHistory: (entryId: string, deltas: readonly FileDelta[], timestamp: string, diagnosis?: readonly MRDiagnosis[], evidence?: readonly SemanticEvidence[]) => Effect.Effect<void, IoError>;
  /** Content-addressed entry lookup lets repeated diffs replay their original report without rewriting state. */
  readonly readHistoryEntry: (entryId: string) => Effect.Effect<StoredHistoryEntry | null, IoError>;
  readonly readAllHistory: () => Effect.Effect<ReadonlyArray<readonly [string, readonly FileDelta[]]>, IoError>;
  /** Optional for legacy test adapters; production storage compacts only sealed entries through this authority. */
  readonly compactHistory?: (rawWindowDays: number, now?: Date) => Effect.Effect<HistoryCompactionResult, IoError>;
  /** Optional only for legacy test adapters; production JSON storage must provide pending evidence lifecycle. */
  readonly readPendingDiff?: () => Effect.Effect<PendingDiffEntry | null, IoError>;
  readonly writePendingDiff?: (entry: PendingDiffEntry) => Effect.Effect<void, IoError>;
  /** Removes replaceable pending state after a complete scan publishes a new generation. */
  readonly clearPendingDiff?: () => Effect.Effect<void, IoError>;
  readonly finalizePendingDiff?: (stagedEvidence: readonly Pick<SemanticEvidence, "file" | "sha256">[]) => Effect.Effect<"finalized" | "missing" | "mismatch", IoError>;
}

export const StorageService = Context.GenericTag<"StorageService", StorageService>("StorageService");
