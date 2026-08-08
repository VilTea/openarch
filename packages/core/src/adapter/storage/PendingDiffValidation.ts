import type { PendingDiffEntry } from "../../port/StorageService";
import type { SemanticEvidence } from "../../domain/crl";
import { IndexEntrySchema } from "../../validation/schemas";

const safeEntryId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value);
const validTimestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(new Date(value).getTime());
const validDeltas = (value: unknown): value is PendingDiffEntry["deltas"] => Array.isArray(value)
  && value.every((delta) => Boolean(delta) && typeof delta === "object" && typeof (delta as { file?: unknown }).file === "string"
    && (delta as { file: string }).file.length > 0 && typeof (delta as { deltaI?: unknown }).deltaI === "number"
    && Number.isFinite((delta as { deltaI: number }).deltaI));

const validBaseMetrics = (metrics: unknown): metrics is PendingDiffEntry["baseMetrics"] => Array.isArray(metrics)
  && metrics.every((metric) => Boolean(metric) && typeof metric === "object"
    && typeof (metric as { file?: unknown }).file === "string"
    && ((metric as { entry?: unknown }).entry === null || IndexEntrySchema.safeParse((metric as { entry?: unknown }).entry).success));

const validEvidence = (evidence: unknown): evidence is PendingDiffEntry["evidence"] => Array.isArray(evidence)
  && evidence.every((item) => Boolean(item) && typeof item === "object" && typeof (item as { file?: unknown }).file === "string"
    && typeof (item as { sha256?: unknown }).sha256 === "string" && /^[0-9a-f]{64}$/.test((item as { sha256: string }).sha256));

const validOverlay = (metrics: unknown): metrics is PendingDiffEntry["overlayMetrics"] => Array.isArray(metrics)
  && metrics.every((entry) => IndexEntrySchema.safeParse(entry).success);

export const parsePendingDiff = (value: unknown): PendingDiffEntry => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pending diff must be an object");
  const raw = value as Partial<PendingDiffEntry>;
  if (!safeEntryId(raw.entryId) || typeof raw.revisionKey !== "string" || raw.revisionKey.length === 0
    || !validTimestamp(raw.timestamp) || !validDeltas(raw.deltas) || !validBaseMetrics(raw.baseMetrics)) {
    throw new Error("pending diff has invalid identity or delta fields");
  }
  if (raw.evidence !== undefined && !validEvidence(raw.evidence)) throw new Error("pending diff has invalid semantic evidence");
  if (raw.overlayMetrics !== undefined && !validOverlay(raw.overlayMetrics)) throw new Error("pending diff has invalid overlay metrics");
  return raw as PendingDiffEntry;
};

/** Candidate time is observational; repeated identical evidence retains its first observation. */
export const pendingContent = (entry: PendingDiffEntry): string => {
  const { timestamp: _timestamp, ...content } = entry;
  return JSON.stringify(content);
};

export const evidenceSignature = (entries: readonly Pick<SemanticEvidence, "file" | "sha256">[]): string =>
  [...new Set(entries.map((entry) => `${entry.file}:${entry.sha256}`))].sort().join("|");
