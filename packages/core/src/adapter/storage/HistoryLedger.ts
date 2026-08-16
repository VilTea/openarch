import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  HISTORY_CHECKPOINT_VERSION,
  compactHistoryRecords,
  historyRetentionCutoff,
  type HistoryCheckpoint,
  type HistoryCompactionResult,
  type SealedHistoryRecord,
} from "../../domain/historyRetention";
import type { FileDelta } from "../../domain/crl";
import type { HistoryImpactFact } from "../../domain/impactCalibration";
import { atomicWriteJson } from "./AtomicWriter";

const CHECKPOINT_FILE = "_checkpoint.v1.json";
const COMPACTION_FILE = "_compaction.v1.json";

const checkpointPath = (directory: string): string => join(directory, CHECKPOINT_FILE);
const compactionPath = (directory: string): string => join(directory, COMPACTION_FILE);

interface PendingCompaction {
  readonly version: "1";
  readonly checkpoint: HistoryCheckpoint;
  readonly compactedEntryIds: readonly string[];
}

const isDeltas = (value: unknown): value is readonly FileDelta[] => Array.isArray(value)
  && value.every((delta) => Boolean(delta) && typeof delta === "object"
    && typeof (delta as FileDelta).file === "string" && (delta as FileDelta).file.length > 0
    && typeof (delta as FileDelta).deltaI === "number" && Number.isFinite((delta as FileDelta).deltaI));

const isTimestamp = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && Number.isFinite(new Date(value).getTime());

const isFingerprint = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const parseCheckpoint = (value: unknown, source: string): HistoryCheckpoint => {
  if (!value || typeof value !== "object") throw new Error(`${source}: checkpoint must be an object`);
  const checkpoint = value as Partial<HistoryCheckpoint>;
  if (checkpoint.schemaVersion !== HISTORY_CHECKPOINT_VERSION || !isTimestamp(checkpoint.compactedAt)
    || typeof checkpoint.sourceEntryCount !== "number" || !Number.isInteger(checkpoint.sourceEntryCount) || checkpoint.sourceEntryCount < 0
    || !isFingerprint(checkpoint.sourceFingerprint) || !isDeltas(checkpoint.deltas)) {
    throw new Error(`${source}: malformed history checkpoint`);
  }
  return checkpoint as HistoryCheckpoint;
};

const readCheckpoint = (directory: string): HistoryCheckpoint | undefined => {
  const path = checkpointPath(directory);
  if (!existsSync(path)) return undefined;
  try { return parseCheckpoint(JSON.parse(readFileSync(path, "utf8")), path); }
  catch (error) { throw error instanceof Error ? error : new Error(`${path}: malformed history checkpoint`); }
};

const readPendingCompaction = (directory: string): PendingCompaction | undefined => {
  const path = compactionPath(directory);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<PendingCompaction>;
    if (value.version !== "1" || !value.checkpoint || !Array.isArray(value.compactedEntryIds)
      || !value.compactedEntryIds.every((entryId) => typeof entryId === "string" && entryId.length > 0)
      || new Set(value.compactedEntryIds).size !== value.compactedEntryIds.length) {
      throw new Error(`${path}: malformed history compaction marker`);
    }
    const checkpoint = parseCheckpoint(value.checkpoint, path);
    if (checkpoint.sourceEntryCount < value.compactedEntryIds.length) {
      throw new Error(`${path}: checkpoint source count precedes compacted entries`);
    }
    return { version: "1", checkpoint, compactedEntryIds: value.compactedEntryIds };
  } catch (error) { throw error instanceof Error ? error : new Error(`${path}: malformed history compaction marker`); }
};

const readRecords = (directory: string): readonly SealedHistoryRecord[] => {
  if (!existsSync(directory)) return [];
  const records = readdirSync(directory)
    .filter((file) => file.endsWith(".json") && file !== CHECKPOINT_FILE && file !== COMPACTION_FILE)
    .sort()
    .map((file) => {
      const path = join(directory, file);
      let value: Partial<SealedHistoryRecord>;
      try { value = JSON.parse(readFileSync(path, "utf8")) as Partial<SealedHistoryRecord>; }
      catch (error) { throw error instanceof Error ? new Error(`${path}: malformed history record: ${error.message}`) : new Error(`${path}: malformed history record`); }
      if (typeof value.entryId !== "string" || value.entryId.length === 0 || !isTimestamp(value.timestamp) || !isDeltas(value.deltas)) {
        throw new Error(`${path}: malformed history record`);
      }
      return { entryId: value.entryId, timestamp: value.timestamp, deltas: value.deltas };
    });
  if (new Set(records.map((record) => record.entryId)).size !== records.length) {
    throw new Error("history contains duplicate entry ids");
  }
  return records;
};

const readableLedger = (directory: string): { readonly checkpoint?: HistoryCheckpoint; readonly records: readonly SealedHistoryRecord[] } => {
  const pending = readPendingCompaction(directory);
  const checkpoint = readCheckpoint(directory);
  if (pending && checkpoint && JSON.stringify(pending.checkpoint) !== JSON.stringify(checkpoint)) {
    throw new Error("history checkpoint disagrees with pending compaction marker");
  }
  const hidden = new Set(pending?.compactedEntryIds ?? []);
  return {
    checkpoint: pending?.checkpoint ?? checkpoint,
    records: readRecords(directory).filter((record) => !hidden.has(record.entryId)),
  };
};

export const readHistoryReplayRecords = (directory: string): readonly (readonly [string, readonly FileDelta[]])[] => {
  const { checkpoint, records } = readableLedger(directory);
  const raw = records.map((record) => [record.timestamp, record.deltas] as const);
  return checkpoint ? [[checkpoint.compactedAt, checkpoint.deltas] as const, ...raw] : raw;
};

/** 冲击量规模参照事实（compaction-safe）：checkpoint 携带 sourceEntryCount 权重，
 *  供项目内同规模分位使用；该投影只服务 report-only 路由证据，不改变 CRL replay。 */
export const readHistoryImpactFacts = (directory: string): readonly HistoryImpactFact[] => {
  const { checkpoint, records } = readableLedger(directory);
  const toFact = (timestamp: string, deltas: readonly FileDelta[], entryCount: number): HistoryImpactFact => ({
    timestamp,
    iPush: deltas.reduce((sum, delta) => sum + delta.deltaI, 0),
    // 与当前 history 写入口径一致：只统计非零 deltaI 的变更文件（校准 2026-08-15）
    fileCount: deltas.filter((delta) => delta.deltaI !== 0).length,
    entryCount,
  });
  const raw = records.map((record) => toFact(record.timestamp, record.deltas, 1));
  return checkpoint ? [toFact(checkpoint.compactedAt, checkpoint.deltas, checkpoint.sourceEntryCount), ...raw] : raw;
};

/** Completes a previously published logical compaction without ever exposing double-counted CRL. */
const recoverPendingCompaction = async (directory: string): Promise<void> => {
  const pending = readPendingCompaction(directory);
  if (!pending) return;
  await atomicWriteJson(checkpointPath(directory), pending.checkpoint);
  for (const entryId of pending.compactedEntryIds) {
    const path = join(directory, `${entryId}.json`);
    if (existsSync(path)) unlinkSync(path);
  }
  if (existsSync(compactionPath(directory))) unlinkSync(compactionPath(directory));
};

/** The filesystem adapter is the sole owner of history checkpoint publication and raw-entry removal. */
export const compactHistoryLedger = async (directory: string, rawWindowDays: number, now = new Date()): Promise<HistoryCompactionResult> => {
  await recoverPendingCompaction(directory);
  const { checkpoint, records } = readableLedger(directory);
  const requestedCutoff = historyRetentionCutoff(now, rawWindowDays);
  const checkpointTime = checkpoint ? new Date(checkpoint.compactedAt) : undefined;
  const cutoff = checkpointTime && checkpointTime > requestedCutoff ? checkpointTime : requestedCutoff;
  const result = compactHistoryRecords(checkpoint, records, cutoff);
  if (result.compactedEntries === 0 || !result.checkpoint) return result;

  const compactedEntryIds = records.filter((record) => !result.retained.includes(record)).map((record) => record.entryId);
  // The marker is the atomic logical publication point: readers switch to its
  // checkpoint and hide listed raw entries before physical cleanup begins.
  await atomicWriteJson(compactionPath(directory), { version: "1", checkpoint: result.checkpoint, compactedEntryIds });
  await recoverPendingCompaction(directory);
  return result;
};
