import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { ZodError } from "zod";
import type { BaselineIndex, IndexEntry, StorageService } from "../../port/StorageService";
import { IoError } from "../../errors/errors";
import { BaselineIndexSchema } from "../../validation/schemas";
import { baselineDirFor, readableBaselineDirFor } from "./BaselineGeneration";
import { baselineShardFileName } from "./BaselineShard";
import {
  canonicalShardPath,
  createBaselineGenerationReadCache,
  type BaselineGenerationReadCache,
  legacyShardPath,
  readBaselineEntry,
  readCompleteGenerationIfCanonical,
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

  return {
    readIndex: () => Effect.try({
      try: (): BaselineIndex | null => {
        const path = indexPath();
        if (!existsSync(path)) return null;
        const generation = readCompleteGenerationIfCanonical(rootDir(), cache);
        return generation?.index ?? BaselineIndexSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      },
      catch: (error) => new IoError({ path: indexPath(), cause: error instanceof ZodError ? formatZod(error) : error }),
    }),

    readFileMetrics: (absPath: string) => Effect.try({
      try: () => {
        const directory = readableDir();
        const complete = readCompleteGenerationIfCanonical(rootDir(), cache);
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

    listAllFileMetrics: () => Effect.try({
      try: () => {
        const directory = readableDir();
        if (!existsSync(directory)) return [];
        const complete = readCompleteGenerationIfCanonical(rootDir(), cache);
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
