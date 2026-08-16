import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, readdirSync, rmSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { makeJsonFileStorageLive } from "../../src/adapter/storage/JsonFileStorage";
import { baselineShardFileName, legacyBaselineShardFileName } from "../../src/adapter/storage/BaselineShard";
import { shardManifestDigest } from "../../src/adapter/storage/BaselineGenerationValidation";
import { StorageService } from "../../src/port/StorageService";

const tmpDir = join(tmpdir(), `openarch-test-${Date.now()}`);

describe("JsonFileStorageLive", () => {
  const layer = makeJsonFileStorageLive(tmpDir);
  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
  });
  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(join(tmpDir, "baseline"), { recursive: true });
  });
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writeFileMetrics → readFileMetrics roundtrip", async () => {
    const path = join(tmpDir, "a.ts");
    const entry = { path, branchCount: 3, nestingDepth: 2, inDegree: 1, outDegree: 2, alphaStruct: 0.36, imports: [join(tmpDir, "b.ts")] };
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* StorageService;
        yield* svc.writeFileMetrics(path, entry);
        const read = yield* svc.readFileMetrics(path);
        expect(read).toEqual(entry);
      }).pipe(Effect.provide(layer))
    );
  });

  it("listAllFileMetrics 返回 [entry.path, entry]，path 权威不依赖文件名", async () => {
    const path = join(tmpDir, "x.ts");
    const entry = { path, branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* StorageService;
        yield* svc.writeFileMetrics(path, entry);
        const all = yield* svc.listAllFileMetrics();
        const found = all.find(([p]) => p === path);
        expect(found).toBeDefined();              // 能按 entry.path 找到
        expect(found![0]).toBe(path);             // key = entry.path，非文件名反解
        expect(found![1].branchCount).toBe(1);
      }).pipe(Effect.provide(layer))
    );
  });

  it("以 entry 的相对 path 作为可移植分片 key", async () => {
    const absolute = join(tmpDir, "portable.ts");
    const entry = { path: "src/portable.ts", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writeFileMetrics(absolute, entry);
    }).pipe(Effect.provide(layer)));
    expect(readFileSync(join(tmpDir, "baseline", baselineShardFileName("src/portable.ts")), "utf8")).toContain("src/portable.ts");
  });

  it("deleteFileMetrics 删除 relative entry.path 的 canonical 分片", async () => {
    const absolute = join(tmpDir, "delete-me.ts");
    const entry = { path: "src/delete-me.ts", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writeFileMetrics(absolute, entry);
      yield* svc.deleteFileMetrics(["src/delete-me.ts"]);
      expect(existsSync(join(tmpDir, "baseline", baselineShardFileName("src/delete-me.ts")))).toBe(false);
    }).pipe(Effect.provide(layer)));
  });

  it("原 separator 编码会碰撞的路径在完整 baseline 中可共存", { timeout: 20_000 }, async () => {
    const first = { path: "src/a__b.ts", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    const second = { path: "src/a/b.ts", branchCount: 2, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.2 };
    const index = { version: "5.2", meta: { scanAt: new Date().toISOString(), nFiles: 2, languages: ["typescript"] } };
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writeBaseline({ entries: [first, second], index });
      expect(new Map(yield* svc.listAllFileMetrics()).get(first.path)).toMatchObject(first);
      expect(new Map(yield* svc.listAllFileMetrics()).get(second.path)).toMatchObject(second);
    }).pipe(Effect.provide(layer)));
    expect(baselineShardFileName(first.path)).not.toBe(baselineShardFileName(second.path));
    expect(readdirSync(join(tmpDir, "baseline"))).toContain(baselineShardFileName(first.path));
    expect(readdirSync(join(tmpDir, "baseline"))).toContain(baselineShardFileName(second.path));
  });

  it("旧 shard 只在 entry.path 匹配时读取，并在新写入后迁移", async () => {
    const path = join(tmpDir, "legacy", "entry.ts");
    const entry = { path, branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    const legacy = join(tmpDir, "baseline", legacyBaselineShardFileName(path));
    writeFileSync(legacy, JSON.stringify(entry));
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      expect(yield* svc.readFileMetrics(path)).toEqual(entry);
      yield* svc.writeFileMetrics(path, entry);
      expect(yield* svc.readFileMetrics(path)).toEqual(entry);
    }).pipe(Effect.provide(layer)));
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(tmpDir, "baseline", baselineShardFileName(path)))).toBe(true);
  });

  it("旧碰撞 shard 不会被误读为另一条路径", async () => {
    const first = join(tmpDir, "legacy-collision", "a__b.ts");
    const second = join(tmpDir, "legacy-collision", "a", "b.ts");
    const entry = { path: second, branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    expect(legacyBaselineShardFileName(first)).toBe(legacyBaselineShardFileName(second));
    writeFileSync(join(tmpDir, "baseline", legacyBaselineShardFileName(first)), JSON.stringify(entry));
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      expect(yield* svc.readFileMetrics(first)).toBeNull();
      expect(yield* svc.readFileMetrics(second)).toEqual(entry);
    }).pipe(Effect.provide(layer)));
  });

  it("writeIndex → readIndex：路径清单 roundtrip", async () => {
    const idx = { version: "5.2", meta: { scanAt: new Date().toISOString(), nFiles: 3, languages: ["typescript"] } };
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* StorageService;
        yield* svc.writeIndex(idx);
        const read = yield* svc.readIndex();
        expect(read?.meta.nFiles).toBe(3);
      }).pipe(Effect.provide(layer))
    );
  });

  it("publishes a complete snapshot and removes stale entries only after validation", async () => {
    const oldEntry = { path: "src/old.ts", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    const nextEntry = { path: "src/next.ts", branchCount: 2, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.2 };
    const index = { version: "5.2", meta: { scanAt: new Date().toISOString(), nFiles: 1, languages: ["typescript"] } };
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writeBaseline({ entries: [oldEntry], index });
      yield* svc.writeBaseline({ entries: [nextEntry], index });
      expect((yield* svc.listAllFileMetrics()).map(([path]) => path)).toContain("src/next.ts");
      expect((yield* svc.listAllFileMetrics()).map(([path]) => path)).not.toContain("src/old.ts");

      const invalid = yield* Effect.either(svc.writeBaseline({ entries: [{ ...nextEntry, path: "" }], index }));
      expect(invalid._tag).toBe("Left");
      expect((yield* svc.listAllFileMetrics()).map(([path]) => path)).toContain("src/next.ts");
    }).pipe(Effect.provide(layer)));
  });

  it("rejects duplicate paths in a complete baseline instead of silently overwriting", async () => {
    const entry = { path: "src/duplicate.ts", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    const index = { version: "5.2", meta: { scanAt: new Date().toISOString(), nFiles: 2, languages: ["typescript"] } };
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      const result = yield* Effect.either(svc.writeBaseline({ entries: [entry, entry], index }));
      expect(result._tag).toBe("Left");
    }).pipe(Effect.provide(layer)));
  });

  it("does not republish an equivalent baseline solely because scanAt changed", async () => {
    const entry = { path: "src/idempotent.ts", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    const first = { version: "5.2", meta: { scanAt: "2026-07-12T00:00:00.000Z", nFiles: 1, languages: ["typescript"] } };
    const repeated = { ...first, meta: { ...first.meta, scanAt: "2026-07-12T01:00:00.000Z" } };
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writeBaseline({ entries: [entry], index: first });
      yield* svc.writeBaseline({ entries: [entry], index: repeated });
      expect((yield* svc.readIndex())?.meta.scanAt).toBe(first.meta.scanAt);
    }).pipe(Effect.provide(layer)));
  });

  it("persists a shard manifest digest for fast validation short-circuit", async () => {
    const entry = { path: "src/manifest.ts", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    const index = { version: "5.2", meta: { scanAt: "2026-08-15T00:00:00.000Z", nFiles: 1, languages: ["typescript"] } };
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writeBaseline({ entries: [entry], index });
      const persisted = yield* svc.readIndex();
      expect(persisted?.meta.shardManifestSha256).toMatch(/^[0-9a-f]{64}$/);
      const directory = join(tmpDir, "baseline");
      expect(persisted!.meta.shardManifestSha256).toBe(shardManifestDigest(directory, persisted!));
    }).pipe(Effect.provide(layer)));
  });

  it("readIndex falls back to the raw index when only the snapshot identity drifted", async () => {
    const entry = { path: "src/identity-drift.ts", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    const index = { version: "5.2", meta: { scanAt: "2026-07-12T00:00:00.000Z", nFiles: 1, languages: ["typescript"] } };
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writeBaseline({ entries: [entry], index });
      const indexPath = join(tmpDir, "baseline", "_index.json");
      const persisted = JSON.parse(readFileSync(indexPath, "utf8"));
      writeFileSync(indexPath, JSON.stringify({ ...persisted, meta: { ...persisted.meta, snapshotSha256: "0".repeat(64) } }));
      expect((yield* svc.readIndex())?.meta.snapshotSha256).toBe("0".repeat(64));
    }).pipe(Effect.provide(layer)));
  });

  it("republishes an equivalent baseline when its persisted snapshot identity is stale", async () => {
    const entry = { path: "src/stale-identity.ts", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    const index = { version: "5.2", meta: { scanAt: "2026-07-12T00:00:00.000Z", nFiles: 1, languages: ["typescript"] } };
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writeBaseline({ entries: [entry], index });
      const indexPath = join(tmpDir, "baseline", "_index.json");
      const stale = JSON.parse(readFileSync(indexPath, "utf8"));
      writeFileSync(indexPath, JSON.stringify({ ...stale, meta: { ...stale.meta, snapshotSha256: "0".repeat(64) } }));
      yield* svc.writeBaseline({ entries: [entry], index });
      expect((yield* svc.readIndex())?.meta.snapshotSha256).not.toBe("0".repeat(64));
    }).pipe(Effect.provide(layer)));
  });

  it("reads the known legacy identity and republishes it with test facts excluded", async () => {
    const entry = {
      path: "src/legacy-test-fact.ts", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1,
      testMetrics: { schemaVersion: "1" as const, providerId: "fixture", tests: [] },
    };
    const index = { version: "5.2", meta: { scanAt: "2026-07-12T00:00:00.000Z", nFiles: 1, languages: ["typescript"] } };
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writeBaseline({ entries: [entry], index });
      const indexPath = join(tmpDir, "baseline", "_index.json");
      const persistedIndex = JSON.parse(readFileSync(indexPath, "utf8"));
      const shard = readdirSync(join(tmpDir, "baseline")).find((name) => name.startsWith("sha256-") && name.endsWith(".json"))!;
      const persistedEntry = JSON.parse(readFileSync(join(tmpDir, "baseline", shard), "utf8"));
      const { scanAt: _scanAt, snapshotSha256: _snapshotSha256, ...meta } = persistedIndex.meta;
      const legacySnapshot = {
        entries: [persistedEntry],
        index: { ...persistedIndex, meta },
      };
      const legacyHash = createHash("sha256").update(JSON.stringify(legacySnapshot)).digest("hex");
      writeFileSync(indexPath, JSON.stringify({ ...persistedIndex, meta: { ...persistedIndex.meta, snapshotSha256: legacyHash } }));

      expect((yield* svc.readIndex())?.meta.snapshotSha256).toBe(legacyHash);
      yield* svc.writeBaseline({ entries: [entry], index });
      expect((yield* svc.readIndex())?.meta.snapshotSha256).not.toBe(legacyHash);
    }).pipe(Effect.provide(layer)));
  });

  it("republishes the same snapshot when a canonical shard is missing", async () => {
    const entry = { path: "src/missing-shard.ts", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    const index = { version: "5.2", meta: { scanAt: "2026-07-12T00:00:00.000Z", nFiles: 1, languages: ["typescript"] } };
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writeBaseline({ entries: [entry], index });
      unlinkSync(join(tmpDir, "baseline", baselineShardFileName(entry.path)));
      expect(yield* svc.writeBaseline({ entries: [entry], index })).toBe(true);
      expect(yield* svc.readFileMetrics(entry.path)).toEqual(entry);
    }).pipe(Effect.provide(layer)));
  });

  it("invalidates the cached generation after a canonical test fact write", async () => {
    const entry = { path: "tests/cache.ts", fileKind: "test" as const, branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0 };
    const index = { version: "5.2", meta: { scanAt: "2026-07-12T00:00:00.000Z", nFiles: 1, nTestFiles: 1, languages: ["typescript"] } };
    const testMetrics = { schemaVersion: "1" as const, providerId: "fixture", tests: [] };
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writeBaseline({ entries: [entry], index });
      yield* svc.readIndex();
      yield* svc.writeFileMetrics(entry.path, { ...entry, testMetrics });
      expect(yield* svc.readFileMetrics(entry.path)).toMatchObject({ testMetrics });
    }).pipe(Effect.provide(layer)));
  });

  it("revalidates a cached generation when a shard changes outside the adapter", async () => {
    const entry = { path: "src/cache-integrity.ts", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    const index = { version: "5.2", meta: { scanAt: "2026-07-12T00:00:00.000Z", nFiles: 1, languages: ["typescript"] } };
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writeBaseline({ entries: [entry], index });
      yield* svc.readIndex();
      writeFileSync(join(tmpDir, "baseline", baselineShardFileName(entry.path)), "{ broken after cache", "utf8");
      expect((yield* Effect.either(svc.readIndex()))._tag).toBe("Left");
    }).pipe(Effect.provide(layer)));
  });

  it("reads an intact backup without promoting it during a read", async () => {
    const entry = { path: "src/backup.ts", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    const index = { version: "5.2", meta: { scanAt: "2026-07-12T00:00:00.000Z", nFiles: 1, languages: ["typescript"] } };
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writeBaseline({ entries: [entry], index });
    }).pipe(Effect.provide(layer)));
    renameSync(join(tmpDir, "baseline"), join(tmpDir, "baseline.backup-test"));
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      expect(yield* svc.readFileMetrics(entry.path)).toEqual(entry);
    }).pipe(Effect.provide(layer)));
    expect(existsSync(join(tmpDir, "baseline"))).toBe(false);
    expect(existsSync(join(tmpDir, "baseline.backup-test"))).toBe(true);
  });

  it("rejects incremental writes while a backup generation is awaiting recovery", async () => {
    const entry = { path: "src/backup-write.ts", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    const index = { version: "5.2", meta: { scanAt: "2026-07-12T00:00:00.000Z", nFiles: 1, languages: ["typescript"] } };
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writeBaseline({ entries: [entry], index });
    }).pipe(Effect.provide(layer)));
    renameSync(join(tmpDir, "baseline"), join(tmpDir, "baseline.backup-test"));

    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      const result = yield* Effect.either(svc.writeFileMetrics(entry.path, { ...entry, crl: 3 }));
      expect(result._tag).toBe("Left");
      expect(yield* svc.readFileMetrics(entry.path)).toEqual(entry);
    }).pipe(Effect.provide(layer)));
    expect(existsSync(join(tmpDir, "baseline"))).toBe(false);
    expect(existsSync(join(tmpDir, "baseline.backup-test"))).toBe(true);
  });

  it("strips history-derived CRL before writing structural baseline entries", async () => {
    const entry = { path: "src/crl-cache.ts", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    const index = { version: "5.2", meta: { scanAt: "2026-07-12T00:00:00.000Z", nFiles: 1, languages: ["typescript"] } };
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writeBaseline({ entries: [entry], index });
      yield* svc.writeFileMetrics(entry.path, { ...entry, crl: 3 });
      expect(yield* svc.readFileMetrics(entry.path)).toEqual(entry);
    }).pipe(Effect.provide(layer)));
  });

  it("readFileMetrics 读 corrupt JSON → IoError", async () => {
    const path = join(tmpDir, "corrupt.ts");
    const entry = { path, branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* StorageService;
        yield* svc.writeFileMetrics(path, entry);
        // 写入后破坏文件内容
        writeFileSync(join(tmpDir, "baseline", baselineShardFileName(path)), "{ broken json", "utf8");
        const either = yield* Effect.either(svc.readFileMetrics(path));
        expect(either._tag).toBe("Left");
      }).pipe(Effect.provide(layer))
    );
  });

  it("readFileMetrics 读缺 path 字段的旧 JSON → IoError（path 必填）", async () => {
    const path = join(tmpDir, "no-path.ts");
    // 直接写缺 path 的旧格式
    writeFileSync(join(tmpDir, "baseline", baselineShardFileName(path)), JSON.stringify({ branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 }), "utf8");
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* StorageService;
        const either = yield* Effect.either(svc.readFileMetrics(path));
        expect(either._tag).toBe("Left");   // Zod 拒绝缺 path
      }).pipe(Effect.provide(layer))
    );
  });

  it("listAllFileMetrics 对 canonical generation 的坏 JSON fail-closed", async () => {
    const goodPath = "src/good2.ts";
    const index = { version: "5.2", meta: { scanAt: new Date().toISOString(), nFiles: 1, languages: ["typescript"] } };
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* StorageService;
        yield* svc.writeBaseline({ entries: [{ path: goodPath, branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 }], index });
        writeFileSync(join(tmpDir, "baseline", baselineShardFileName(goodPath)), "{ totally broken", "utf8");
        const result = yield* Effect.either(svc.listAllFileMetrics());
        expect(result._tag).toBe("Left");
      }).pipe(Effect.provide(layer))
    );
  });

  it("rejects a canonical generation whose index count no longer matches its shards", async () => {
    const entry = { path: "src/count.ts", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    const index = { version: "5.2", meta: { scanAt: new Date().toISOString(), nFiles: 1, languages: ["typescript"] } };
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writeBaseline({ entries: [entry], index });
      const indexPath = join(tmpDir, "baseline", "_index.json");
      const raw = JSON.parse(readFileSync(indexPath, "utf8"));
      writeFileSync(indexPath, JSON.stringify({ ...raw, meta: { ...raw.meta, nFiles: 2 } }), "utf8");
      const result = yield* Effect.either(svc.listAllFileMetrics());
      expect(result._tag).toBe("Left");
    }).pipe(Effect.provide(layer)));
  });

  it("writeHistory persists optional MR diagnosis without changing CRL replay fields", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* StorageService;
        yield* svc.writeHistory("diagnosis-entry", [{ file: "a.ts", deltaI: 1 }], "2026-07-11T00:00:00.000Z", [{
          file: "a.ts", scope: "existing",
          localBurden: { metrics: {
            branch: { before: 1, after: 2, delta: 1, normalizedDelta: 0.02 },
            nesting: { before: 0, after: 0, delta: 0, normalizedDelta: 0 },
            loc: { before: 10, after: 10, delta: 0, normalizedDelta: 0 },
            externalPassthrough: { before: 0, after: 0, delta: 0, normalizedDelta: 0 },
          }, deterioration: 0.02, improvement: 0 },
          exposure: { before: 0.1, after: 0.2, delta: 0.1 },
        }]);
        const all = yield* svc.readAllHistory();
        expect(all.find(([timestamp]) => timestamp === "2026-07-11T00:00:00.000Z")?.[1]).toEqual([{ file: "a.ts", deltaI: 1 }]);
      }).pipe(Effect.provide(layer))
    );
    const raw = JSON.parse(readFileSync(join(tmpDir, "history", "diagnosis-entry.json"), "utf8"));
    expect(raw.diagnosis[0].localBurden.deterioration).toBe(0.02);
  });

  it("keeps the first content-addressed history entry when an identical operation repeats", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writeHistory("stable-entry", [{ file: "a.ts", deltaI: 1 }], "2026-07-12T00:00:00.000Z");
      yield* svc.writeHistory("stable-entry", [{ file: "a.ts", deltaI: 99 }], "2026-07-12T01:00:00.000Z");
    }).pipe(Effect.provide(layer)));
    const raw = JSON.parse(readFileSync(join(tmpDir, "history", "stable-entry.json"), "utf8"));
    expect(raw).toMatchObject({ timestamp: "2026-07-12T00:00:00.000Z", deltas: [{ file: "a.ts", deltaI: 1 }] });
  });

  it("compacts aged history into one checkpoint without changing its CRL projection", async () => {
    const root = join(tmpDir, "history-compaction");
    const compactedLayer = makeJsonFileStorageLive(root);
    const now = new Date("2026-08-01T00:00:00.000Z");
    const before = await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writeHistory("old-a", [{ file: "src/a.ts", deltaI: 12 }], "2026-01-01T00:00:00.000Z");
      yield* svc.writeHistory("old-b", [{ file: "src/b.ts", deltaI: 8 }], "2026-02-01T00:00:00.000Z");
      yield* svc.writeHistory("recent", [{ file: "src/a.ts", deltaI: 2 }], "2026-07-20T00:00:00.000Z");
      return yield* svc.readAllHistory();
    }).pipe(Effect.provide(compactedLayer)));
    const after = await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      const compacted = yield* svc.compactHistory!(180, now);
      expect(compacted).toMatchObject({ compactedEntries: 2, retainedEntries: 1 });
      expect(yield* svc.compactHistory!(180, now)).toMatchObject({ compactedEntries: 0, retainedEntries: 1 });
      return yield* svc.readAllHistory();
    }).pipe(Effect.provide(compactedLayer)));
    const { replayHistoricalCrl } = await import("../../src/application/governance/historyCrl");
    const beforeCrl = replayHistoricalCrl(before, now);
    const afterCrl = replayHistoricalCrl(after, now);
    for (const [file, value] of beforeCrl) expect(afterCrl.get(file)).toBeCloseTo(value, 12);
    expect(existsSync(join(root, "history", "old-a.json"))).toBe(false);
    expect(existsSync(join(root, "history", "_checkpoint.v1.json"))).toBe(true);
  });

  it("reads a published compaction marker without double-counting, then recovers physical cleanup", async () => {
    const root = join(tmpDir, "history-compaction-recovery");
    const directory = join(root, "history");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "old.json"), JSON.stringify({ entryId: "old", timestamp: "2026-01-01T00:00:00.000Z", deltas: [{ file: "src/a.ts", deltaI: 10 }] }));
    writeFileSync(join(directory, "_compaction.v1.json"), JSON.stringify({
      version: "1",
      checkpoint: { schemaVersion: "1", compactedAt: "2026-03-01T00:00:00.000Z", sourceEntryCount: 1, sourceFingerprint: "a".repeat(64), deltas: [{ file: "src/a.ts", deltaI: 5 }] },
      compactedEntryIds: ["old"],
    }));
    const recoveryLayer = makeJsonFileStorageLive(root);

    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      expect(yield* svc.readAllHistory()).toEqual([["2026-03-01T00:00:00.000Z", [{ file: "src/a.ts", deltaI: 5 }]]]);
      expect(yield* svc.compactHistory!(180, new Date("2026-08-01T00:00:00.000Z"))).toMatchObject({ compactedEntries: 0 });
      expect(yield* svc.readAllHistory()).toEqual([["2026-03-01T00:00:00.000Z", [{ file: "src/a.ts", deltaI: 5 }]]]);
    }).pipe(Effect.provide(recoveryLayer)));
    expect(existsSync(join(directory, "old.json"))).toBe(false);
    expect(existsSync(join(directory, "_compaction.v1.json"))).toBe(false);
  });

  it("fails closed when a compaction marker or raw history record is malformed", async () => {
    const root = join(tmpDir, "history-corrupt");
    const directory = join(root, "history");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "old.json"), JSON.stringify({ entryId: "old", timestamp: "2026-01-01T00:00:00.000Z", deltas: [{ file: "src/a.ts", deltaI: 10 }] }));
    writeFileSync(join(directory, "_compaction.v1.json"), "{ broken marker", "utf8");
    const corruptMarkerLayer = makeJsonFileStorageLive(root);
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      expect((yield* Effect.either(svc.readAllHistory()))._tag).toBe("Left");
      expect((yield* Effect.either(svc.compactHistory!(180, new Date("2026-08-01T00:00:00.000Z"))))._tag).toBe("Left");
    }).pipe(Effect.provide(corruptMarkerLayer)));

    rmSync(join(directory, "_compaction.v1.json"));
    writeFileSync(join(directory, "broken.json"), "{ broken record", "utf8");
    const corruptRecordLayer = makeJsonFileStorageLive(root);
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      expect((yield* Effect.either(svc.readAllHistory()))._tag).toBe("Left");
    }).pipe(Effect.provide(corruptRecordLayer)));
  });

  it("replaces a pending candidate and seals it only when staged hashes match", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      yield* svc.writePendingDiff!({
        entryId: "pending-old", revisionKey: "head-a", timestamp: "2026-07-12T00:00:00.000Z",
        deltas: [{ file: "a.ts", deltaI: 1 }], evidence: [{ file: "a.ts", anchor: "a", changeKind: "function_body", sha256: "a".repeat(64) }], baseMetrics: [],
      });
      yield* svc.writePendingDiff!({
        entryId: "pending-new", revisionKey: "head-a", timestamp: "2026-07-12T00:01:00.000Z",
        deltas: [{ file: "a.ts", deltaI: 2 }], evidence: [{ file: "a.ts", anchor: "a", changeKind: "function_body", sha256: "b".repeat(64) }], baseMetrics: [],
      });
      expect((yield* svc.readPendingDiff!())?.entryId).toBe("pending-new");
      expect(yield* svc.finalizePendingDiff!([{ file: "a.ts", sha256: "a".repeat(64) }])).toBe("mismatch");
      expect(yield* svc.finalizePendingDiff!([{ file: "a.ts", sha256: "b".repeat(64) }])).toBe("finalized");
      expect(yield* svc.readPendingDiff!()).toBeNull();
    }).pipe(Effect.provide(layer)));
    const raw = JSON.parse(readFileSync(join(tmpDir, "history", "pending-new.json"), "utf8"));
    expect(raw.deltas).toEqual([{ file: "a.ts", deltaI: 2 }]);
    expect(raw.evidence[0].sha256).toBe("b".repeat(64));
  });

  it("keeps an identical pending candidate byte-stable when only observation time changes", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* StorageService;
      const first = {
        entryId: "pending-stable", revisionKey: "head-a", timestamp: "2026-07-12T00:00:00.000Z",
        deltas: [{ file: "a.ts", deltaI: 1 }], evidence: [{ file: "a.ts", anchor: "a", changeKind: "function_body" as const, sha256: "c".repeat(64) }], baseMetrics: [],
      };
      yield* svc.writePendingDiff!(first);
      const before = readFileSync(join(tmpDir, "pending", "diff.json"), "utf8");
      yield* svc.writePendingDiff!({ ...first, timestamp: "2026-07-12T00:01:00.000Z" });
      expect(readFileSync(join(tmpDir, "pending", "diff.json"), "utf8")).toBe(before);
    }).pipe(Effect.provide(layer)));
  });

  it("projects a hash-matching pending after-metric without mutating the complete baseline", async () => {
    const sourceName = `openarch-current-overlay-${Date.now()}.ts`;
    const source = join(tmpDir, "..", sourceName);
    const baseline = { path: sourceName, branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    const overlay = { ...baseline, branchCount: 4, nestingDepth: 3, alphaStruct: 0.4 };
    try {
      writeFileSync(source, "export const value = 2;\n");
      const sha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
      await Effect.runPromise(Effect.gen(function* () {
        const svc = yield* StorageService;
        yield* svc.writeBaseline({ entries: [baseline], index: {
          version: "5.2", meta: { scanAt: new Date().toISOString(), snapshotSha256: "a".repeat(64), nFiles: 1, languages: ["typescript"], analysisScope: { fingerprint: "scope", complete: true }, metricContractVersion: "metric-contract-v3" },
        } });
        const published = yield* svc.readIndex();
        yield* svc.writePendingDiff!({ entryId: "overlay", revisionKey: "head", timestamp: new Date().toISOString(), baselineSnapshotSha256: published?.meta.snapshotSha256, deltas: [], baseMetrics: [], evidence: [{ file: overlay.path, sha256 }], overlayMetrics: [overlay] });
        expect(new Map(yield* svc.listAllFileMetrics()).get(baseline.path)).toMatchObject(baseline);
        expect(new Map(yield* svc.listCurrentFileMetrics!()).get(overlay.path)).toMatchObject(overlay);
        writeFileSync(source, "export const value = 3;\n");
        expect(new Map(yield* svc.listCurrentFileMetrics!()).get(overlay.path)).toMatchObject(baseline);
        expect(new Map(yield* svc.listCurrentFileMetrics!("pending")).get(overlay.path)).toMatchObject(overlay);
      }).pipe(Effect.provide(layer)));
    } finally {
      try { unlinkSync(source); } catch { /* test cleanup */ }
    }
  });
});
