import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { ZodError } from "zod";
import type { BaselineIndex, BaselineSnapshot, IndexEntry, StorageService } from "../../port/StorageService";
import { IoError } from "../../errors/errors";
import { BaselineIndexSchema } from "../../validation/schemas";
import { baselineDirFor, readableBaselineDirFor } from "./BaselineGeneration";
import { BaselineIdentityMismatchError, readBaselineGenerationDirectoryAsync, validateBaselineGenerationDirectoryAsync } from "./BaselineGenerationValidation";
import { baselineShardFileName } from "./BaselineShard";
import {
  canonicalShardPath,
  createBaselineGenerationReadCache,
  type BaselineGenerationReadCache,
  generationManifest,
  hasCanonicalShards,
  invalidateBaselineGenerationReadCache,
  legacyShardPath,
  readBaselineEntry,
  requestedBaselinePaths,
} from "./BaselineStoreAccess";

type JsonBaselineReadStore = Pick<StorageService, "readIndex" | "readFileMetrics" | "listAllFileMetrics">;
const formatZod = (error: ZodError): string => error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");

export const createJsonBaselineReadStore = (
  rootDir: () => string,
  cache: BaselineGenerationReadCache = createBaselineGenerationReadCache(),
): JsonBaselineReadStore => {
  const readableDir = () => readableBaselineDirFor(rootDir());
  const writableDir = () => baselineDirFor(rootDir());
  const indexPath = () => join(readableDir(), "_index.json");

  const readIndexRaw = (path: string): BaselineIndex =>
    BaselineIndexSchema.parse(JSON.parse(readFileSync(path, "utf8")));

  /** Cached or async full-generation read for consumers that need entries. */
  const completeSnapshot = async (): Promise<BaselineSnapshot | null> => {
    const directory = readableDir();
    const indexFile = join(directory, "_index.json");
    if (!existsSync(indexFile)) {
      invalidateBaselineGenerationReadCache(cache);
      return null;
    }
    const manifest = generationManifest(directory);
    if (cache.key === manifest.key && cache.snapshot) return cache.snapshot;
    const index = BaselineIndexSchema.parse(JSON.parse(await readFile(indexFile, "utf8")));
    // Legacy generation without canonical shards cannot be deep-validated;
    // even a snapshotSha256-bearing fixture must fall back to legacy reads.
    if (!manifest.hasCanonicalShards) {
      invalidateBaselineGenerationReadCache(cache);
      return null;
    }
    const snapshot = await readBaselineGenerationDirectoryAsync(directory);
    cache.key = manifest.key;
    cache.snapshot = snapshot;
    return snapshot;
  };

  return {
    readIndex: () => Effect.tryPromise({
      try: async (): Promise<BaselineIndex | null> => {
        const path = indexPath();
        if (!existsSync(path)) return null;
        try {
          const index = readIndexRaw(path);
          // Legacy generation without canonical shards has no deep identity;
          // return the raw index exactly like the pre-canonical path did.
          // 校准 2026-08-15：snapshotSha256 存在但目录没有 canonical shards
          // （测试/迁移夹具）时也不做深校验，避免伪造身份触发无意义的 IoError。
          if (!hasCanonicalShards(readableDir())) return index;
          // manifest 摘要命中时跳过全量分片解析；未命中走完整深校验。
          // 身份漂移仍回退到原始 index（供全量重建）。
          return await validateBaselineGenerationDirectoryAsync(readableDir());
        } catch (error) {
          if (error instanceof BaselineIdentityMismatchError) return readIndexRaw(path);
          throw error;
        }
      },
      catch: (error) => new IoError({ path: indexPath(), cause: error instanceof ZodError ? formatZod(error) : error }),
    }),

    readFileMetrics: (absPath: string) => Effect.tryPromise({
      try: async (): Promise<IndexEntry | null> => {
        const directory = readableDir();
        const complete = await completeSnapshot();
        if (complete) {
          const normalized = new Set(requestedBaselinePaths(absPath));
          return complete.entries.find((entry) => normalized.has(entry.path)) ?? null;
        }
        const paths = requestedBaselinePaths(absPath);
        for (const entryPath of paths) {
          const shard = canonicalShardPath(directory, entryPath);
          if (!existsSync(shard)) continue;
          const entry = readBaselineEntry(shard);
          if (entry.path !== entryPath) throw new Error(`canonical baseline shard does not match ${entryPath}`);
          return entry;
        }
        for (const entryPath of paths) {
          const shard = legacyShardPath(directory, entryPath);
          if (!existsSync(shard)) continue;
          const entry = readBaselineEntry(shard);
          if (entry.path === entryPath) return entry;
        }
        return null;
      },
      catch: (error) => new IoError({ path: absPath, cause: error instanceof ZodError ? formatZod(error) : error }),
    }),

    listAllFileMetrics: () => Effect.tryPromise({
      try: async (): Promise<ReadonlyArray<readonly [string, IndexEntry]>> => {
        const directory = readableDir();
        if (!existsSync(directory)) return [];
        const complete = await completeSnapshot();
        if (complete) return complete.entries.map((entry) => [entry.path, entry] as const);
        const entries = new Map<string, { entry: IndexEntry; priority: number }>();
        for (const file of readdirSync(directory).filter((name) => name.endsWith(".json") && name !== "_index.json")) {
          try {
            const entry = readBaselineEntry(join(directory, file));
            const priority = file === baselineShardFileName(entry.path) ? 2 : 1;
            const previous = entries.get(entry.path);
            if (!previous || priority > previous.priority) entries.set(entry.path, { entry, priority });
          } catch { /* legacy shard compatibility: an index-backed generation never reaches this path */ }
        }
        return [...entries.entries()].map(([path, { entry }]) => [path, entry] as const);
      },
      catch: (error) => new IoError({ path: writableDir(), cause: error }),
    }),
  };
};
