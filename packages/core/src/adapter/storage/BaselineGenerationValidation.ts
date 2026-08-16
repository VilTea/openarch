import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BaselineIndex, BaselineSnapshot, IndexEntry } from "../../port/StorageService";
import { BaselineIndexSchema, IndexEntrySchema } from "../../validation/schemas";

const assertCount = (actual: number, expected: number | undefined, label: string): void => {
  if (expected !== undefined && actual !== expected) throw new Error(`baseline generation ${label} does not match index`);
};

const validateEntries = (index: BaselineSnapshot["index"], entries: readonly IndexEntry[]): void => {
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error("baseline generation contains duplicate entry paths");
  }
  assertCount(entries.length, index.meta.nFiles, `entry count ${entries.length}`);
  assertCount(entries.filter((entry) => (entry.fileKind ?? "production") === "production").length, index.meta.nProductionFiles, "production count");
  assertCount(entries.filter((entry) => entry.fileKind === "test").length, index.meta.nTestFiles, "test count");
};

const comparableSnapshot = (snapshot: BaselineSnapshot, includeTestMetrics: boolean): string => {
  // shardManifestSha256 与 snapshotSha256 一样是校验提示，不是快照内容。
  const { scanAt: _scanAt, snapshotSha256: _snapshotSha256, shardManifestSha256: _shardManifestSha256, ...meta } = snapshot.index.meta;
  const entries = [...snapshot.entries]
    .map((entry) => {
      if (includeTestMetrics) return entry;
      const { testMetrics: _testMetrics, ...structural } = entry;
      return structural;
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  return JSON.stringify({ entries, index: { ...snapshot.index, meta } });
};

const identityFor = (snapshot: BaselineSnapshot, includeTestMetrics: boolean): string =>
  createHash("sha256").update(comparableSnapshot(snapshot, includeTestMetrics)).digest("hex");

/** Structural identity excludes independently refreshed test-provider facts. */
export const snapshotIdentity = (snapshot: BaselineSnapshot): string => identityFor(snapshot, false);

/** Read-only migration identity used by baselines created before test facts split. */
const legacySnapshotIdentity = (snapshot: BaselineSnapshot): string => identityFor(snapshot, true);

export const normalizeBaselineSnapshot = (snapshot: BaselineSnapshot): BaselineSnapshot => {
  const entries = snapshot.entries.map((entry) => IndexEntrySchema.parse(entry));
  const index = BaselineIndexSchema.parse(snapshot.index);
  validateEntries(index, entries);
  return { index, entries };
};

const validatePersistedIdentity = (snapshot: BaselineSnapshot): void => {
  const persisted = snapshot.index.meta.snapshotSha256;
  if (!persisted) return;
  if (persisted !== snapshotIdentity(snapshot) && persisted !== legacySnapshotIdentity(snapshot)) {
    throw new BaselineIdentityMismatchError();
  }
};

/** Typed signal that shards drifted from the persisted snapshot identity. Index JSON itself may still be usable for full-rebuild recovery. */
export class BaselineIdentityMismatchError extends Error {
  constructor() {
    super("baseline generation snapshot identity does not match its contents");
    this.name = "BaselineIdentityMismatchError";
  }
}

const shardNames = (directory: string): readonly string[] =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".json") && name !== "_index.json")
    .sort();

/** Key-order-independent serialization: the same JSON document read via zod may have different property order than the publish-time object. */
const stableStringify = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

/** Deterministic projection of the index without the manifest hint itself. */
const indexContentFingerprint = (index: BaselineIndex): string => {
  const { shardManifestSha256: _shardManifestSha256, ...meta } = index.meta;
  return stableStringify({ version: index.version, meta });
};

/**
 * Content-addressed digest of index content + shard directory stat manifest.
 * It is a validation hint written at publish time: a digest mismatch proves a
 * change, while a match only allows skipping a redundant deep re-read in read
 * paths. It is never used to fabricate missing entries.
 */
export const shardManifestDigest = (directory: string, index: BaselineIndex): string => {
  // 只用 size+mtime：staging 目录经 rename 发布后，Windows 上 ctime/ino 可能
  // 变化，会导致持久化摘要永远失配。size+mtime 是稳定且足够触发重校验的信号。
  const lines = shardNames(directory).map((name) => {
    const stat = statSync(join(directory, name));
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  });
  return createHash("sha256").update(indexContentFingerprint(index) + "\n" + lines.join("\n")).digest("hex");
};

/**
 * Validates one generation directory without necessarily parsing every shard:
 * when the persisted shard manifest digest matches the directory, the shards
 * and index have not changed since publish and the already-persisted snapshot
 * identity is authoritative. A digest mismatch falls back to the complete deep
 * read (including index-only edits such as a rewritten snapshotSha256).
 */
export const validateBaselineGenerationDirectory = (directory: string): BaselineIndex => {
  const index = BaselineIndexSchema.parse(JSON.parse(readFileSync(join(directory, "_index.json"), "utf8")));
  if (typeof index.meta.shardManifestSha256 === "string" && index.meta.shardManifestSha256 === shardManifestDigest(directory, index)) {
    return index;
  }
  return readBaselineGenerationDirectory(directory).index;
};

/** Async manifest computation for read-only paths: stats overlap via a bounded worker window instead of blocking the loop. */
export const shardManifestDigestAsync = async (directory: string, index: BaselineIndex, concurrency = 16): Promise<string> => {
  const names = shardNames(directory);
  const stats = await mapWithConcurrency(names, concurrency, (name) => stat(join(directory, name)));
  const lines = names.map((name, position) => `${name}:${stats[position].size}:${stats[position].mtimeMs}`);
  return createHash("sha256").update(indexContentFingerprint(index) + "\n" + lines.join("\n")).digest("hex");
};

/** Async validation with the same short-circuit semantics as the sync variant. */
export const validateBaselineGenerationDirectoryAsync = async (directory: string, concurrency = 16): Promise<BaselineIndex> => {
  const index = BaselineIndexSchema.parse(JSON.parse(await readFile(join(directory, "_index.json"), "utf8")));
  if (typeof index.meta.shardManifestSha256 === "string" && index.meta.shardManifestSha256 === await shardManifestDigestAsync(directory, index, concurrency)) {
    return index;
  }
  return (await readBaselineGenerationDirectoryAsync(directory)).index;
};

const mapWithConcurrency = async <T>(items: readonly string[], concurrency: number, worker: (item: string, position: number) => Promise<T>): Promise<T[]> => {
  const results = new Array<T>(items.length);
  let next = 0;
  let firstError: unknown;
  let firstErrorPosition = Number.POSITIVE_INFINITY;
  const work = async (): Promise<void> => {
    while (firstError === undefined) {
      const position = next;
      next += 1;
      if (position >= items.length) return;
      try {
        results[position] = await worker(items[position], position);
      } catch (error) {
        // 并发失败按文件顺序取第一条，保证报告不随调度顺序漂移。
        if (position < firstErrorPosition) {
          firstError = error;
          firstErrorPosition = position;
        }
        return;
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, work);
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
  return results;
};

/**
 * Async read of a complete generation with bounded concurrency. Publish and
 * recovery paths keep the synchronous reader; read-only projections use this
 * path to overlap shard I/O without changing validation semantics.
 */
export const readBaselineGenerationDirectoryAsync = async (directory: string, concurrency = 8): Promise<BaselineSnapshot> => {
  const index = BaselineIndexSchema.parse(JSON.parse(await readFile(join(directory, "_index.json"), "utf8")));
  const names = shardNames(directory);
  const entries = await mapWithConcurrency(names, concurrency, async (name) =>
    IndexEntrySchema.parse(JSON.parse(await readFile(join(directory, name), "utf8"))),
  );
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const snapshot = { index, entries };
  validateEntries(index, entries);
  validatePersistedIdentity(snapshot);
  return snapshot;
};

/** Parses and validates one complete generation without changing filesystem state. */
export const readBaselineGenerationDirectory = (directory: string): BaselineSnapshot => {
  const index = BaselineIndexSchema.parse(JSON.parse(readFileSync(join(directory, "_index.json"), "utf8")));
  const entries = readdirSync(directory)
    .filter((name) => name.endsWith(".json") && name !== "_index.json")
    .map((name) => IndexEntrySchema.parse(JSON.parse(readFileSync(join(directory, name), "utf8"))));
  const snapshot = { index, entries };
  validateEntries(index, entries);
  validatePersistedIdentity(snapshot);
  return snapshot;
};
