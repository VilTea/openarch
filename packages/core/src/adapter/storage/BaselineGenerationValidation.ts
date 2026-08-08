import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BaselineSnapshot, IndexEntry } from "../../port/StorageService";
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
  const { scanAt: _scanAt, snapshotSha256: _snapshotSha256, ...meta } = snapshot.index.meta;
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
    throw new Error("baseline generation snapshot identity does not match its contents");
  }
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
