import type { DocumentStore } from "./DocumentStore";
import { readDocumentIndex } from "./DocumentIndex";
import { unfilledDocuments } from "./DocumentFill";
import { unresolvedSimilarityCandidates } from "./DocumentDispositions";
import { readGovernanceObservation } from "./GovernanceObservation";

export interface DocumentStoreObservability {
  readonly scopeId: string;
  readonly mode: DocumentStore["mode"];
  readonly scopeRoot: string;
  readonly gitRoot: string;
  readonly scopeConfigured: boolean;
  readonly indexed: number;
  readonly unfilled: readonly string[];
  readonly openCandidates: number;
  readonly lastSimilarityCheckAt?: string;
  readonly lastCapabilityMaintenanceAt?: string;
}

/** Read-only document governance state for `docs status` and `docs check --json`. */
export const documentStoreObservability = (store: DocumentStore): DocumentStoreObservability => {
  const index = readDocumentIndex(store);
  const all = Object.keys(index.entries);
  const similarity = readGovernanceObservation(store.scopeRoot, "document-similarity");
  const capability = readGovernanceObservation(store.scopeRoot, "capability-maintenance");
  return {
    scopeId: store.scopeId,
    mode: store.mode,
    scopeRoot: store.scopeRoot,
    gitRoot: store.gitRoot,
    scopeConfigured: store.scopeConfigured,
    indexed: all.length,
    unfilled: unfilledDocuments(store, new Set(all)),
    openCandidates: unresolvedSimilarityCandidates(store).length,
    ...(similarity ? { lastSimilarityCheckAt: similarity.at } : {}),
    ...(capability ? { lastCapabilityMaintenanceAt: capability.at } : {}),
  };
};
