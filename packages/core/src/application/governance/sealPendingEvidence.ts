import { Effect } from "effect";
import { StorageService } from "../../port/StorageService";
import type { HistoryCompactionResult } from "../../domain/historyRetention";
import type { SemanticEvidence } from "../../domain/crl";
import { withGovernanceWriteLock } from "./writeLock";

export interface SealPendingEvidenceOptions {
  readonly stagedEvidence: readonly Pick<SemanticEvidence, "file" | "sha256">[];
  readonly rawWindowDays: number;
  readonly now?: Date;
  readonly agentId?: string;
}

export interface SealPendingEvidenceResult {
  readonly status: "finalized" | "missing" | "mismatch";
  readonly compaction?: HistoryCompactionResult;
}

/**
 * Owns the staged-evidence write transaction. The adapter owns file formats;
 * this application workflow owns serialization across finalize and compaction.
 */
export const sealPendingEvidence = (options: SealPendingEvidenceOptions) =>
  Effect.gen(function* () {
    const storage = yield* StorageService;
    return yield* withGovernanceWriteLock(
      options.agentId ?? process.env.OPENARCH_AGENT_ID ?? "pre-commit",
      () => Effect.gen(function* () {
        const status = storage.finalizePendingDiff
          ? yield* storage.finalizePendingDiff(options.stagedEvidence)
          : "missing" as const;
        if (status !== "finalized") return { status } satisfies SealPendingEvidenceResult;
        const compaction = storage.compactHistory
          ? yield* storage.compactHistory(options.rawWindowDays, options.now)
          : undefined;
        return { status, ...(compaction ? { compaction } : {}) } satisfies SealPendingEvidenceResult;
      }),
    );
  });
