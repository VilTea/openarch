import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import type { BaselineIndex, BaselineSnapshot, IndexEntry, StorageService } from "../../port/StorageService";
import { IoError } from "../../errors/errors";
import { BaselineIndexSchema, IndexEntrySchema } from "../../validation/schemas";
import { atomicWriteJsonIfChanged } from "./AtomicWriter";
import { baselineDirFor, publishBaselineSnapshot, readableBaselineDirFor } from "./BaselineGeneration";
import { baselineShardFileName } from "./BaselineShard";
import {
  assertMutableLegacyState,
  assertNoPendingBaselineRecovery,
  createBaselineGenerationReadCache,
  deleteLegacyShardIfOwned,
  invalidateBaselineGenerationReadCache,
} from "./BaselineStoreAccess";
import { createJsonBaselineReadStore } from "./JsonBaselineReadStore";

type JsonBaselineStore = Pick<StorageService,
  "writeBaseline" | "readIndex" | "writeIndex" | "writeCanonicalIndex" | "writeFileMetrics" | "deleteFileMetrics" | "readFileMetrics" | "listAllFileMetrics" | "clearFileMetrics">;

/** Owns coherent baseline generation and individual shard compatibility. */
export const createJsonBaselineStore = (rootDir: () => string): JsonBaselineStore => {
  const generationCache = createBaselineGenerationReadCache();
  /** Reads never promote backups or delete files; only publication may recover a previous generation. */
  const readableDir = () => readableBaselineDirFor(rootDir());
  const writableDir = () => baselineDirFor(rootDir());
  const indexPath = () => join(readableDir(), "_index.json");

  return {
    ...createJsonBaselineReadStore(rootDir, generationCache),
    writeBaseline: (snapshot: BaselineSnapshot) =>
      Effect.tryPromise({
        try: () => {
          invalidateBaselineGenerationReadCache(generationCache);
          return publishBaselineSnapshot(rootDir(), snapshot);
        },
        catch: (error) => new IoError({ path: writableDir(), cause: error }),
      }),

    writeIndex: (index: BaselineIndex) =>
      Effect.tryPromise({
        try: async () => {
          invalidateBaselineGenerationReadCache(generationCache);
          const directory = writableDir();
          assertMutableLegacyState(rootDir());
          mkdirSync(directory, { recursive: true });
          await atomicWriteJsonIfChanged(join(directory, "_index.json"), BaselineIndexSchema.parse(index));
        },
        catch: (error) => new IoError({ path: indexPath(), cause: error }),
      }),

    writeCanonicalIndex: (index: BaselineIndex) =>
      Effect.tryPromise({
        try: async () => {
          invalidateBaselineGenerationReadCache(generationCache);
          // 增量发布要求没有 pending recovery（backup 存在时先完成全量 scan）。
          assertNoPendingBaselineRecovery(rootDir());
          const directory = writableDir();
          mkdirSync(directory, { recursive: true });
          await atomicWriteJsonIfChanged(join(directory, "_index.json"), BaselineIndexSchema.parse(index));
        },
        catch: (error) => new IoError({ path: indexPath(), cause: error }),
      }),

    writeFileMetrics: (absPath: string, entry: IndexEntry) =>
      Effect.tryPromise({
        try: async () => {
          invalidateBaselineGenerationReadCache(generationCache);
          assertNoPendingBaselineRecovery(rootDir());
          const normalized = IndexEntrySchema.parse(entry);
          const directory = writableDir();
          mkdirSync(directory, { recursive: true });
          await atomicWriteJsonIfChanged(join(directory, baselineShardFileName(normalized.path)), normalized);
          deleteLegacyShardIfOwned(directory, normalized.path);
        },
        catch: (error) => new IoError({ path: absPath, cause: error }),
      }),

    deleteFileMetrics: (paths: readonly string[]) =>
      Effect.try({
        try: () => {
          invalidateBaselineGenerationReadCache(generationCache);
          assertNoPendingBaselineRecovery(rootDir());
          const directory = writableDir();
          for (const path of paths) {
            const shard = join(directory, baselineShardFileName(path));
            if (existsSync(shard)) unlinkSync(shard);
            deleteLegacyShardIfOwned(directory, path);
          }
        },
        catch: (error) => new IoError({ path: writableDir(), cause: error }),
      }),

    clearFileMetrics: () =>
      Effect.try({
        try: () => {
          invalidateBaselineGenerationReadCache(generationCache);
          const directory = writableDir();
          assertMutableLegacyState(rootDir());
          if (!existsSync(directory)) return;
          for (const file of readdirSync(directory)) {
            if (file.endsWith(".json") && file !== "_index.json") {
              try { unlinkSync(join(directory, file)); } catch { /* skip transient filesystem failure */ }
            }
          }
        },
        catch: (error) => new IoError({ path: writableDir(), cause: error }),
      }),
  };
};
