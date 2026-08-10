import { Effect, Layer } from "effect";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { StorageService, type IndexEntry } from "../../port/StorageService";
import { createJsonBaselineStore } from "./JsonBaselineStore";
import { createJsonHistoryStore } from "./JsonHistoryStore";
import { createJsonPendingDiffStore } from "./JsonPendingDiffStore";
import { createJsonSymbolCalibrationStore } from "./JsonSymbolCalibrationStore";
import { SymbolCalibrationStore } from "../../port/SymbolCalibrationStore";
import { IndexEntrySchema } from "../../validation/schemas";
import { toPosixPath } from "../../infra/paths";

// Resolve the environment lazily so independently constructed test layers stay isolated.
const baseDir = () => process.env.OPENARCH_BASE_DIR ?? ".openarch";

/**
 * Composition root for JSON persistence. Baseline generations, immutable
 * history, and replaceable staged evidence keep separate lifecycle rules but
 * present the single StorageService port required by applications.
 */
const storageLayer = (rootDir: () => string) => Layer.merge(
  Layer.sync(
    StorageService,
    () => {
      const baseline = createJsonBaselineStore(rootDir);
      const history = createJsonHistoryStore(rootDir);
      const pending = createJsonPendingDiffStore(rootDir);
      const storage = { ...baseline, ...history, ...pending };

      return {
        ...storage,
        listCurrentFileMetrics: (projection = "worktree") =>
          Effect.gen(function* () {
            const complete = yield* storage.listAllFileMetrics();
            const candidate = yield* storage.readPendingDiff();
            const index = yield* storage.readIndex();
            if (!candidate?.overlayMetrics?.length) return complete;
            if (candidate.baselineSnapshotSha256 !== index?.meta.snapshotSha256) return complete;

            const evidenceByFile = new Map(
              (candidate.evidence ?? []).map((evidence) => [toPosixPath(evidence.file), evidence.sha256]),
            );
            const projected = new Map(complete);
            for (const value of candidate.overlayMetrics) {
              const parsed = IndexEntrySchema.safeParse(value);
              if (!parsed.success) continue;
              const entry = parsed.data;
              const path = toPosixPath(entry.path);
              const expected = evidenceByFile.get(path);
              if (!expected) continue;
              const absolute = isAbsolute(path) ? path : resolve(rootDir(), "..", path);
              if (projection === "pending") {
                projected.set(path, entry);
                continue;
              }
              if (!existsSync(absolute)) continue;
              const actual = createHash("sha256").update(readFileSync(absolute)).digest("hex");
              if (actual === expected) projected.set(path, entry);
            }
            return [...projected.entries()] as ReadonlyArray<readonly [string, IndexEntry]>;
          }),
      };
    },
  ),
  Layer.sync(SymbolCalibrationStore, () => createJsonSymbolCalibrationStore(rootDir)),
);

/** Test/integration seam: isolates storage without mutating process-wide configuration. */
export const makeJsonFileStorageLive = (rootDir: string) => storageLayer(() => rootDir);

/** Production layer keeps resolving OPENARCH_BASE_DIR when an effect is provided. */
export const JsonFileStorageLive = storageLayer(baseDir);
