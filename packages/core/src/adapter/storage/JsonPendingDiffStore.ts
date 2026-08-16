import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import type { PendingDiffEntry, StorageService } from "../../port/StorageService";
import { IoError } from "../../errors/errors";
import { atomicWriteJson } from "./AtomicWriter";
import { evidenceSignature, parsePendingDiff, pendingContent } from "./PendingDiffValidation";

type JsonPendingDiffStore = Required<Pick<StorageService, "readPendingDiff" | "writePendingDiff" | "clearPendingDiff" | "finalizePendingDiff">>;

/** Owns replaceable worktree evidence and its staged-to-history seal. */
export const createJsonPendingDiffStore = (rootDir: () => string): JsonPendingDiffStore => {
  const pendingPath = () => `${rootDir()}/pending/diff.json`;
  return {
    readPendingDiff: () =>
      Effect.try({
        try: () => {
          const path = pendingPath();
          if (!existsSync(path)) return null;
          return parsePendingDiff(JSON.parse(readFileSync(path, "utf8")));
        },
        catch: (error) => new IoError({ path: pendingPath(), cause: error }),
      }),

    writePendingDiff: (entry) =>
      Effect.tryPromise({
        try: async () => {
          const path = pendingPath();
          mkdirSync(join(rootDir(), "pending"), { recursive: true });
          const normalized = parsePendingDiff(entry);
          if (existsSync(path)) {
            const current = parsePendingDiff(JSON.parse(readFileSync(path, "utf8")));
            if (pendingContent(current) === pendingContent(entry)) return;
          }
          await atomicWriteJson(path, normalized);
        },
        catch: (error) => new IoError({ path: pendingPath(), cause: error }),
      }),

    clearPendingDiff: () =>
      Effect.try({
        try: () => {
          const path = pendingPath();
          if (existsSync(path)) unlinkSync(path);
        },
        catch: (error) => new IoError({ path: pendingPath(), cause: error }),
      }),

    finalizePendingDiff: (stagedEvidence) =>
      Effect.tryPromise({
        try: async () => {
          const path = pendingPath();
          if (!existsSync(path)) return "missing" as const;
          const pending = parsePendingDiff(JSON.parse(readFileSync(path, "utf8")));
          if (evidenceSignature(pending.evidence ?? []) !== evidenceSignature(stagedEvidence)) return "mismatch" as const;
          const directory = join(rootDir(), "history");
          mkdirSync(directory, { recursive: true });
          const historyPath = join(directory, `${pending.entryId}.json`);
          if (!existsSync(historyPath)) {
            await atomicWriteJson(historyPath, {
              timestamp: pending.timestamp, entryId: pending.entryId, deltas: pending.deltas,
              ...(pending.diagnosis ? { diagnosis: pending.diagnosis } : {}),
              ...(pending.evidence ? { evidence: pending.evidence } : {}),
              ...(pending.scale ? { scale: pending.scale } : {}),
            });
          }
          unlinkSync(path);
          return "finalized" as const;
        },
        catch: (error) => new IoError({ path: pendingPath(), cause: error }),
      }),
  };
};
