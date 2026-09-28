import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { BaselineSnapshot } from "../../port/StorageService";
import { atomicWriteJson } from "./AtomicWriter";
import { retryTransientFileOperation } from "./TransientFileRetry";
import { baselineShardFileName } from "./BaselineShard";
import { mapWithConcurrency } from "../../infra/boundedConcurrency";
import { normalizeBaselineSnapshot, readBaselineGenerationDirectory, shardManifestDigest, snapshotIdentity } from "./BaselineGenerationValidation";

export const baselineDirFor = (root: string) => join(root, "baseline");

const backupDirectories = (root: string): readonly string[] =>
  !existsSync(root) ? [] : readdirSync(root)
    .filter((name) => name.startsWith("baseline.backup-"))
    .sort()
    .reverse()
    .map((name) => join(root, name));

export const hasBackupGeneration = (root: string): boolean => backupDirectories(root).length > 0;

/** Selects a readable generation without moving or deleting filesystem state. */
export const readableBaselineDirFor = (root: string): string => {
  const active = baselineDirFor(root);
  if (existsSync(active)) return active;
  return backupDirectories(root)[0] ?? active;
};

/** Reads a complete generation, without performing recovery side effects. */
export const readBaselineGeneration = (root: string): BaselineSnapshot | null => {
  const directory = readableBaselineDirFor(root);
  const indexPath = join(directory, "_index.json");
  return existsSync(indexPath) ? readBaselineGenerationDirectory(directory) : null;
};

export const recoverBaseline = (root: string): void => {
  const active = baselineDirFor(root);
  if (existsSync(active) || !existsSync(root)) return;
  for (const backup of backupDirectories(root)) {
    try {
      readBaselineGenerationDirectory(backup);
      renameSync(backup, active);
      return;
    } catch {
      // Keep an invalid backup for explicit diagnostics instead of promoting it.
    }
  }
};

const withSnapshotFingerprint = (snapshot: BaselineSnapshot): BaselineSnapshot => {
  const snapshotSha256 = snapshotIdentity(snapshot);
  return { ...snapshot, index: { ...snapshot.index, meta: { ...snapshot.index.meta, snapshotSha256 } } };
};

const activeSnapshotMatches = (root: string, snapshot: BaselineSnapshot): boolean => {
  try {
    const generation = readBaselineGeneration(root);
    if (!generation) return false;
    const index = generation.index;
    if (snapshot.index.meta.snapshotSha256 && index.meta.snapshotSha256 === snapshot.index.meta.snapshotSha256) return true;
    // A persisted content-addressed identity that disagrees with the freshly
    // projected snapshot is stale or corrupt. Only legacy snapshots without
    // an identity may use structural comparison as a compatibility fallback.
    if (index.meta.snapshotSha256 !== undefined) return false;
    return snapshotIdentity(generation) === snapshotIdentity(snapshot);
  } catch {
    return false;
  }
};

const stagingPaths = (root: string) => {
  const active = baselineDirFor(root);
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { active, staging: `${active}.staging-${token}`, backup: `${active}.backup-${token}` };
};

/**
 * 分片写入的并发度（D1 取证 2026-09-27）。
 *
 * 缺陷：这里原本是 `for (const entry of snapshot.entries) await atomicWriteJson(...)` ——
 * 完全串行。实测（本仓 663 文件，仓库所在卷）单次小 JSON 的 atomic 写（写临时文件 + rename）
 * 约 **64ms**，串行即 **~42s**；而解析整个仓库只要 ~4s。分片路径互不相同、发布是**整目录 rename**，
 * 写入顺序没有任何语义，因此改为有界并发。失败仍由调用方的 try/catch 清理 staging。
 */
const SHARD_WRITE_CONCURRENCY = 16;

const writeStagingGeneration = async (staging: string, active: string, snapshot: BaselineSnapshot): Promise<void> => {
  mkdirSync(staging, { recursive: true });
  // 写库剪枝（校准 2026-08-08）：增量 scan 只重算少量分片——staging 先复制 active
  // 快照（未变更分片直接沿用，避免 500+ 次串行 atomicWriteJson），再只覆盖
  // 变更分片、删除已删除分片。无 changedPaths 时保持全量写（向后兼容）。
  // 注：linkSync 硬链接方案在 publish 后 identity 校验不一致（inode 语义与
  // snapshotIdentity 冲突），回退 cpSync——分片级 publish 需要先解决 writeIndex
  // 的 canonical 不可变约束（下一轮）。
  if (snapshot.changedPaths && existsSync(active)) {
    cpSync(active, staging, { recursive: true });
    for (const deleted of snapshot.deletedPaths ?? []) {
      rmSync(join(staging, baselineShardFileName(deleted)), { force: true });
    }
    const changed = new Set(snapshot.changedPaths.map((path) => baselineShardFileName(path)));
    const changedEntries = snapshot.entries.filter((entry) => changed.has(baselineShardFileName(entry.path)));
    await mapWithConcurrency(changedEntries, (entry) => atomicWriteJson(join(staging, baselineShardFileName(entry.path)), entry), SHARD_WRITE_CONCURRENCY);
  } else {
    await mapWithConcurrency(snapshot.entries, (entry) => atomicWriteJson(join(staging, baselineShardFileName(entry.path)), entry), SHARD_WRITE_CONCURRENCY);
  }
  // 发布时把「index 内容指纹 + 分片目录 stat manifest」摘要写进 index：
  // 后续只读校验可先比较 manifest，一致时跳过重复深解析；任何 index 或分片
  // 变化都会使摘要失配并回退完整身份校验，不伪造事实。
  const indexWithManifest = {
    ...snapshot.index,
    meta: { ...snapshot.index.meta, shardManifestSha256: shardManifestDigest(staging, snapshot.index) },
  };
  await atomicWriteJson(join(staging, "_index.json"), indexWithManifest);
};

const publishGeneration = async (paths: ReturnType<typeof stagingPaths>): Promise<void> => {
  if (existsSync(paths.active)) await retryTransientFileOperation(() => rename(paths.active, paths.backup));
  try {
    await retryTransientFileOperation(() => rename(paths.staging, paths.active));
  } catch (error) {
    if (!existsSync(paths.active) && existsSync(paths.backup)) await retryTransientFileOperation(() => rename(paths.backup, paths.active));
    throw error;
  }
  if (existsSync(paths.backup)) rmSync(paths.backup, { recursive: true, force: true });
};

/** Publishes only a validated, complete generation and preserves the prior one on failure. */
export const publishBaselineSnapshot = async (root: string, snapshot: BaselineSnapshot): Promise<boolean> => {
  const fingerprinted = withSnapshotFingerprint(normalizeBaselineSnapshot(snapshot));
  mkdirSync(root, { recursive: true });
  recoverBaseline(root);
  if (activeSnapshotMatches(root, fingerprinted)) return false;
  const paths = stagingPaths(root);
  try {
    await writeStagingGeneration(paths.staging, paths.active, fingerprinted);
    await publishGeneration(paths);
    return true;
  } catch (error) {
    if (existsSync(paths.staging)) rmSync(paths.staging, { recursive: true, force: true });
    throw error;
  }
};
