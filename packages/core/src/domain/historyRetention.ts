import { createHash } from "node:crypto";
import type { FileDelta } from "./crl";

export const HISTORY_CHECKPOINT_VERSION = "1" as const;
export const DEFAULT_HISTORY_RAW_WINDOW_DAYS = 180;

export interface SealedHistoryRecord {
  readonly entryId: string;
  readonly timestamp: string;
  readonly deltas: readonly FileDelta[];
}

/**
 * A checkpoint is one virtual history event whose deltas are already valued at
 * `compactedAt`. Replaying it with recent raw entries is mathematically equal
 * to replaying every compacted entry after that instant.
 */
export interface HistoryCheckpoint {
  readonly schemaVersion: typeof HISTORY_CHECKPOINT_VERSION;
  readonly compactedAt: string;
  readonly sourceEntryCount: number;
  readonly sourceFingerprint: string;
  readonly deltas: readonly FileDelta[];
}

export interface HistoryCompactionResult {
  readonly compactedEntries: number;
  readonly retainedEntries: number;
  readonly checkpoint?: HistoryCheckpoint;
}

const lambda = Math.log(2) / 60;

const sortedDeltas = (values: ReadonlyMap<string, number>): readonly FileDelta[] =>
  [...values.entries()]
    .filter(([, deltaI]) => Number.isFinite(deltaI) && deltaI !== 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, deltaI]) => ({ file, deltaI }));

const fingerprint = (previous: string | undefined, records: readonly SealedHistoryRecord[]): string =>
  createHash("sha256").update(JSON.stringify({
    previous,
    records: [...records]
      .sort((left, right) => left.entryId.localeCompare(right.entryId))
      .map(({ entryId, timestamp, deltas }) => ({ entryId, timestamp, deltas })),
  })).digest("hex");

const addScaled = (target: Map<string, number>, deltas: readonly FileDelta[], factor: number): void => {
  for (const delta of deltas) target.set(delta.file, (target.get(delta.file) ?? 0) + delta.deltaI * factor);
};

/** Returns a stable cutoff; the same day and policy never create a new checkpoint. */
export const historyRetentionCutoff = (now: Date, rawWindowDays: number): Date => {
  const cutoff = new Date(now.getTime() - rawWindowDays * 86_400_000);
  cutoff.setUTCHours(0, 0, 0, 0);
  return cutoff;
};

/**
 * Advances a checkpoint only when raw records have crossed the retention
 * window. A prior checkpoint is rescaled to the new cutoff, preserving CRL
 * exactly while replacing O(commits) history with O(changed paths) state.
 */
export const compactHistoryRecords = (
  checkpoint: HistoryCheckpoint | undefined,
  records: readonly SealedHistoryRecord[],
  cutoff: Date,
): HistoryCompactionResult & { readonly retained: readonly SealedHistoryRecord[] } => {
  const cutoffMs = cutoff.getTime();
  const compacted = records.filter((record) => new Date(record.timestamp).getTime() <= cutoffMs);
  const retained = records.filter((record) => !compacted.includes(record));
  if (compacted.length === 0) return { compactedEntries: 0, retainedEntries: retained.length, checkpoint, retained };

  const contributions = new Map<string, number>();
  if (checkpoint) {
    const ageDays = Math.max(0, (cutoffMs - new Date(checkpoint.compactedAt).getTime()) / 86_400_000);
    addScaled(contributions, checkpoint.deltas, Math.exp(-lambda * ageDays));
  }
  for (const record of compacted) {
    const ageDays = Math.max(0, (cutoffMs - new Date(record.timestamp).getTime()) / 86_400_000);
    addScaled(contributions, record.deltas, Math.exp(-lambda * ageDays));
  }
  const next: HistoryCheckpoint = {
    schemaVersion: HISTORY_CHECKPOINT_VERSION,
    compactedAt: cutoff.toISOString(),
    sourceEntryCount: (checkpoint?.sourceEntryCount ?? 0) + compacted.length,
    sourceFingerprint: fingerprint(checkpoint?.sourceFingerprint, compacted),
    deltas: sortedDeltas(contributions),
  };
  return { compactedEntries: compacted.length, retainedEntries: retained.length, checkpoint: next, retained };
};
