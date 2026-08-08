import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { BaselineSnapshot, IndexEntry } from "../../port/StorageService";
import { BaselineIndexSchema, IndexEntrySchema } from "../../validation/schemas";
import { toRelative } from "../../infra/paths";
import { baselineDirFor, hasBackupGeneration, readableBaselineDirFor, readBaselineGeneration } from "./BaselineGeneration";
import { baselineShardFileName, legacyBaselineShardFileName } from "./BaselineShard";

/** A validated generation can be reused while its on-disk manifest is unchanged. */
export interface BaselineGenerationReadCache {
  key?: string;
  snapshot?: BaselineSnapshot;
}

export const createBaselineGenerationReadCache = (): BaselineGenerationReadCache => ({});

export const invalidateBaselineGenerationReadCache = (cache: BaselineGenerationReadCache): void => {
  cache.key = undefined;
  cache.snapshot = undefined;
};

const generationManifest = (directory: string): { readonly key: string; readonly hasCanonicalShards: boolean } => {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const manifest = files.map((name) => {
    const stat = statSync(join(directory, name));
    return [name, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join(":");
  });
  return {
    key: `${directory}\0${manifest.join("|")}`,
    hasCanonicalShards: files.some((name) => /^sha256-[0-9a-f]{64}\.json$/.test(name)),
  };
};

export const hasCanonicalShards = (directory: string): boolean => readdirSync(directory, { withFileTypes: true })
  .some((entry) => entry.isFile() && /^sha256-[0-9a-f]{64}\.json$/.test(entry.name));

export const readCompleteGenerationIfCanonical = (root: string, cache?: BaselineGenerationReadCache): BaselineSnapshot | null => {
  const directory = readableBaselineDirFor(root);
  const index = join(directory, "_index.json");
  if (!existsSync(index)) {
    if (cache) invalidateBaselineGenerationReadCache(cache);
    return null;
  }
  const manifest = generationManifest(directory);
  if (cache?.key === manifest.key && cache.snapshot) return cache.snapshot;
  const parsed = BaselineIndexSchema.parse(JSON.parse(readFileSync(index, "utf8")));
  if (!parsed.meta.snapshotSha256 && !manifest.hasCanonicalShards) {
    if (cache) invalidateBaselineGenerationReadCache(cache);
    return null;
  }
  const snapshot = readBaselineGeneration(root);
  if (!snapshot) {
    if (cache) invalidateBaselineGenerationReadCache(cache);
    return null;
  }
  if (cache) {
    cache.key = manifest.key;
    cache.snapshot = snapshot;
  }
  return snapshot;
};

export const assertMutableLegacyState = (root: string): void => {
  assertNoPendingBaselineRecovery(root);
  const directory = baselineDirFor(root);
  const index = join(directory, "_index.json");
  if (!existsSync(index)) return;
  const parsed = BaselineIndexSchema.parse(JSON.parse(readFileSync(index, "utf8")));
  if (parsed.meta.snapshotSha256 || hasCanonicalShards(directory)) {
    throw new Error("canonical baseline is immutable; publish a complete snapshot with scan instead");
  }
};

/** Legacy writes must not create an active directory while publication recovery is pending. */
export const assertNoPendingBaselineRecovery = (root: string): void => {
  if (hasBackupGeneration(root)) {
    throw new Error("baseline recovery is pending; complete a full scan before incremental writes");
  }
};

export const readBaselineEntry = (path: string): IndexEntry => IndexEntrySchema.parse(JSON.parse(readFileSync(path, "utf8")));

export const requestedBaselinePaths = (absPath: string): readonly string[] => [...new Set([toRelative(absPath), absPath])];

export const deleteLegacyShardIfOwned = (directory: string, entryPath: string): void => {
  const path = join(directory, legacyBaselineShardFileName(entryPath));
  if (!existsSync(path)) return;
  try {
    if (readBaselineEntry(path).path === entryPath) unlinkSync(path);
  } catch { /* corrupt legacy shard is retained for explicit recovery */ }
};

export const canonicalShardPath = (directory: string, entryPath: string): string =>
  join(directory, baselineShardFileName(entryPath));

export const legacyShardPath = (directory: string, entryPath: string): string =>
  join(directory, legacyBaselineShardFileName(entryPath));
