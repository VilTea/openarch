import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readBaselineGenerationDirectoryAsync, validateBaselineGenerationDirectory } from "../../src/adapter/storage/BaselineGenerationValidation";

const entry = (path: string, branchCount = 1) => ({ path, branchCount, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 });
const baselineFileName = (path: string) => `sha256-${createHash("sha256").update(path).digest("hex")}.json`;

describe("baseline async deep reader", () => {
  const root = mkdtempSync(join(tmpdir(), "openarch-async-read-"));
  const directory = join(root, "baseline");

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writeGeneration = (count: number, brokenAt = -1): void => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    for (let i = 0; i < count; i += 1) {
      const item = entry(`src/file-${i}.ts`, i + 1);
      writeFileSync(join(directory, baselineFileName(item.path)), JSON.stringify(brokenAt === i ? "{ broken" : item));
    }
    const index = { version: "5.2", meta: { scanAt: "2026-08-15T00:00:00.000Z", nFiles: count, nProductionFiles: count, nTestFiles: 0, languages: ["typescript"] } };
    writeFileSync(join(directory, "_index.json"), JSON.stringify(index));
  };

  it("reads and validates a complete generation with bounded concurrency", async () => {
    writeGeneration(12);
    const snapshot = await readBaselineGenerationDirectoryAsync(directory, 4);
    expect(snapshot.entries).toHaveLength(12);
    expect(new Set(snapshot.entries.map((item) => item.path))).toEqual(
      new Set(Array.from({ length: 12 }, (_, i) => `src/file-${i}.ts`)),
    );
  });

  it("fails with the first malformed shard deterministically", async () => {
    writeGeneration(12, 3);
    await expect(readBaselineGenerationDirectoryAsync(directory, 4)).rejects.toThrow();
  });

  it("validate short-circuit still catches an index rewrite even when shards are untouched", () => {
    writeGeneration(4);
    const indexPath = join(directory, "_index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    const persisted = { ...index, meta: { ...index.meta, snapshotSha256: "0".repeat(64) } };
    writeFileSync(indexPath, JSON.stringify(persisted));
    expect(() => validateBaselineGenerationDirectory(directory)).toThrow(/identity/);
  });
});
