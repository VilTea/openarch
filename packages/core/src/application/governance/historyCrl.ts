// Sealed history is the sole durable input for historical CRL. Baseline entries
// retain structural facts only; consumers must replay this Fact instead of
// reading a per-file cache.
import type { FileDelta } from "../../domain/crl";
import { computeCrl } from "../../domain/crl";

export type StoredHistoryDeltas = ReadonlyArray<readonly [string, readonly FileDelta[]]>;

export const replayHistoricalCrl = (entries: StoredHistoryDeltas, now = new Date()): ReadonlyMap<string, number> =>
  computeCrl(entries.map(([timestamp, deltas]) => ({ timestamp, deltas })), now);
