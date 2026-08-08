import type { DocumentStore } from "./DocumentStore";
import { capabilityAssetPath } from "./DocumentStore";
import { contentSha256, INDEX_VERSION } from "./DocumentFingerprint";
import { writeDocumentIndex } from "./DocumentIndex";
import { recordGovernanceObservation } from "./GovernanceObservation";
import { documentStoreRelativePath, updateDocumentIndex, type DocumentCheckInput } from "./DocumentIndexUpdate";
import { findDocumentSimilarityCandidates, type DocumentSimilarityCandidate } from "./DocumentSimilarityCandidates";

export type { DocumentCheckInput } from "./DocumentIndexUpdate";
export type { DocumentSimilarityCandidate } from "./DocumentSimilarityCandidates";

export interface DocumentCheckReport {
  readonly availability: "available" | "unavailable";
  readonly reason?: string;
  readonly scopeId: string;
  readonly indexed: number;
  readonly updated: number;
  readonly candidates: readonly DocumentSimilarityCandidate[];
}

export const checkDocuments = (input: DocumentCheckInput): DocumentCheckReport => {
  if (!input.store.scopeConfigured) return { availability: "unavailable", reason: "shared document scope 未登记", scopeId: input.store.scopeId, indexed: 0, updated: 0, candidates: [] };
  const updated = updateDocumentIndex(input);
  writeDocumentIndex(input.store, { version: INDEX_VERSION, scopeId: input.store.scopeId, entries: Object.fromEntries(updated.entries) });
  const fingerprint = contentSha256([...updated.changed].sort().map((path) => `${path}:${updated.entries.get(path)?.contentSha256 ?? "deleted"}`).join("\n"));
  recordGovernanceObservation(input.store.scopeRoot, "document-similarity", { status: "success", at: new Date().toISOString(), inputFingerprint: fingerprint });
  const capabilityPath = documentStoreRelativePath(input.store, capabilityAssetPath(input.store));
  const capabilityFingerprint = updated.entries.get(capabilityPath)?.contentSha256;
  if (input.changedPaths && updated.changed.has(capabilityPath) && capabilityFingerprint) {
    recordGovernanceObservation(input.store.scopeRoot, "capability-maintenance", {
      status: "success",
      at: new Date().toISOString(),
      inputFingerprint: capabilityFingerprint,
    });
  }
  return { availability: "available", scopeId: input.store.scopeId, indexed: updated.entries.size, updated: [...updated.changed].filter((path) => updated.entries.has(path)).length, candidates: findDocumentSimilarityCandidates(updated.entries, updated.changed, input.store.scopeId) };
};

export { documentStoreRelativePath } from "./DocumentIndexUpdate";
