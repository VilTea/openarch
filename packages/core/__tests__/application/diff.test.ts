import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { diff } from "../../src/application/diff";
import { ParserService } from "../../src/port/ParserService";
import { StorageService, type IndexEntry, type StoredHistoryEntry } from "../../src/port/StorageService";
import { LockService } from "../../src/port/LockService";
import type { FileAst } from "../../src/domain/ast";
import type { MRDiagnosis } from "../../src/domain/mrDiagnosis";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

const before: IndexEntry = {
  path: "src/dmr-sample.ts",
  fileKind: "production",
  branchCount: 2,
  nestingDepth: 1,
  inDegree: 0,
  outDegree: 0,
  alphaStruct: 0.1,
  imports: [],
  loc: 20,
  maxFuncBranch: 2,
  externalPassthroughCalls: 1,
};

const after: FileAst = {
  path: before.path,
  language: "typescript",
  branchCount: 4,
  nestingDepth: 3,
  functionCount: 1,
  passthroughCalls: 3,
  externalPassthroughCalls: 3,
  loc: 50,
  maxFuncBranch: 4,
  imports: [],
  functions: [{ name: "run", branchCount: 4, calls: [] }],
};

describe("diff D_MR integration", () => {
  it("requires a content-addressed baseline when neither baseline nor git HEAD is available (cold-start fallback absent)", async () => {
    const ParserTest = Layer.succeed(ParserService, {
      parse: () => Effect.succeed(after), query: () => Effect.succeed([]), supportedLanguages: Effect.succeed(["typescript"]),
    });
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: () => Effect.void,
      readIndex: () => Effect.succeed({ version: "1", meta: { scanAt: "2026-07-11T00:00:00.000Z", nFiles: 1, languages: ["typescript"] } }),
      writeIndex: () => Effect.void, writeFileMetrics: () => Effect.void, deleteFileMetrics: () => Effect.void,
      readFileMetrics: () => Effect.succeed(before), listAllFileMetrics: () => Effect.succeed([[before.path, before]]), clearFileMetrics: () => Effect.void,
      writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null), readAllHistory: () => Effect.succeed([]),
    });
    const LockTest = Layer.succeed(LockService, {
      acquire: () => Effect.succeed({ name: "diff", agentId: "test", acquiredAt: 0, lockId: "test-lock" }), release: () => Effect.void,
    });

    // 在无 git 的临时目录跑：无 snapshotSha256 且无 git HEAD → 冷启动 fallback 不可用 → 仍失败。
    await withTemporaryDirectory("diff-coldstart", async (cwd) => {
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
      try {
        const exit = await Effect.runPromiseExit(diff({
          changedFiles: [before.path], baselinePath: ".openarch/baseline.json", changeKind: "function_body", agentId: "test",
        }).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest))));
        expect(exit._tag).toBe("Failure");
      } finally {
        cwdSpy.mockRestore();
      }
    });
  });

  it("replaces pending evidence while retaining the sealed baseline metric", async () => {
    let current: IndexEntry = before;
    const canonicalWrites: IndexEntry[] = [];
    const pendingWrites: import("../../src/port/StorageService").PendingDiffEntry[] = [];
    const ParserTest = Layer.succeed(ParserService, {
      parse: () => Effect.succeed(after), query: () => Effect.succeed([]), supportedLanguages: Effect.succeed(["typescript"]),
    });
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: () => Effect.void,
      readIndex: () => Effect.succeed({ version: "1", meta: {
        scanAt: "2026-07-11T00:00:00.000Z", snapshotSha256: "a".repeat(64), nFiles: 10, nProductionFiles: 10, languages: ["typescript"],
        p95: { branch: 10, nesting: 10, loc: 100, alpha: 1, oneMinusConnectedness: 1, externalPassthrough: 10 },
      } }),
      writeIndex: () => Effect.void,
      writeFileMetrics: (_path, entry) => Effect.sync(() => { canonicalWrites.push(entry); current = entry; }), deleteFileMetrics: () => Effect.void,
      readFileMetrics: () => Effect.succeed(current), listAllFileMetrics: () => Effect.succeed([[before.path, current]]), clearFileMetrics: () => Effect.void,
      writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null), readAllHistory: () => Effect.succeed([]),
      readPendingDiff: () => Effect.succeed(pendingWrites.at(-1) ?? null),
      writePendingDiff: (entry) => Effect.sync(() => { pendingWrites.push(entry); }),
    });
    const LockTest = Layer.succeed(LockService, {
      acquire: () => Effect.succeed({ name: "diff", agentId: "test", acquiredAt: 0, lockId: "test-lock" }), release: () => Effect.void,
    });
    const input = {
      changedFiles: [before.path], baselinePath: ".openarch/baseline.json", changeKind: "function_body" as const,
      persistence: "pending" as const, revisionKey: "head-a", agentId: "test",
    };
    const layer = Layer.mergeAll(ParserTest, StorageTest, LockTest);
    const first = await Effect.runPromise(diff(input).pipe(Effect.provide(layer)));
    const second = await Effect.runPromise(diff(input).pipe(Effect.provide(layer)));

    expect(pendingWrites).toHaveLength(2);
    expect(canonicalWrites).toHaveLength(0);
    expect(second.summary.dMR).toBeCloseTo(first.summary.dMR, 6);
    expect(pendingWrites[1].baseMetrics).toEqual([{ file: before.path, entry: before }]);
  });

  it("persists a non-zero local-burden diagnosis when a baseline file becomes more complex", async () => {
    const histories: MRDiagnosis[][] = [];
    const written: IndexEntry[] = [];
    const ParserTest = Layer.succeed(ParserService, {
      parse: () => Effect.succeed(after),
      query: () => Effect.succeed([]),
      supportedLanguages: Effect.succeed(["typescript"]),
    });
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: () => Effect.void,
      readIndex: () => Effect.succeed({
        version: "1",
        meta: {
          scanAt: "2026-07-11T00:00:00.000Z", snapshotSha256: "a".repeat(64),
          nFiles: 10,
          nProductionFiles: 10,
          languages: ["typescript"],
          p95: { branch: 10, nesting: 10, loc: 100, alpha: 1, oneMinusConnectedness: 1, externalPassthrough: 10 },
        },
      }),
      writeIndex: () => Effect.void,
      writeFileMetrics: (_path, entry) => Effect.sync(() => { written.push(entry); }), deleteFileMetrics: () => Effect.void,
      readFileMetrics: () => Effect.succeed(before),
      listAllFileMetrics: () => Effect.succeed([[before.path, before]]),
      clearFileMetrics: () => Effect.void,
      writeHistory: (_id, _deltas, _timestamp, diagnosis) => Effect.sync(() => { histories.push([...(diagnosis ?? [])]); }),
      readHistoryEntry: () => Effect.succeed(null),
      readAllHistory: () => Effect.succeed([]),
    });
    const LockTest = Layer.succeed(LockService, {
      acquire: () => Effect.succeed({ name: "diff", agentId: "test", acquiredAt: 0, lockId: "test-lock" }),
      release: () => Effect.void,
    });

    const report = await Effect.runPromise(diff({
      changedFiles: [before.path], baselinePath: ".openarch/baseline.json", changeKind: "function_body", agentId: "test",
    }).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest))));

    expect(report.summary.dMR).toBeCloseTo(0.155, 6);
    expect(report.evidence.mrDetail[0].localBurden.metrics).toMatchObject({
      branch: { delta: 2 }, nesting: { delta: 2 }, loc: { delta: 30 }, externalPassthrough: { delta: 2 },
    });
    expect(histories).toHaveLength(1);
    expect(histories[0][0].localBurden.deterioration).toBeCloseTo(report.summary.dMR, 6);
    expect(written).toHaveLength(0);
  });

  it("uses Git/AST before metrics when a scan has already refreshed the mutable baseline", async () => {
    const refreshed = { ...before, branchCount: after.branchCount, nestingDepth: after.nestingDepth, loc: after.loc, maxFuncBranch: after.maxFuncBranch, externalPassthroughCalls: after.externalPassthroughCalls, alphaStruct: 0.4 };
    const ParserTest = Layer.succeed(ParserService, {
      parse: () => Effect.succeed(after), query: () => Effect.succeed([]), supportedLanguages: Effect.succeed(["typescript"]),
    });
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: () => Effect.void,
      readIndex: () => Effect.succeed({ version: "1", meta: {
        scanAt: "2026-07-11T00:00:00.000Z", snapshotSha256: "a".repeat(64), nFiles: 10, nProductionFiles: 10, languages: ["typescript"],
        p95: { branch: 10, nesting: 10, loc: 100, alpha: 1, oneMinusConnectedness: 1, externalPassthrough: 10 },
      } }),
      writeIndex: () => Effect.void, writeFileMetrics: () => Effect.void, deleteFileMetrics: () => Effect.void,
      readFileMetrics: () => Effect.succeed(refreshed), listAllFileMetrics: () => Effect.succeed([[before.path, refreshed]]), clearFileMetrics: () => Effect.void,
      writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null), readAllHistory: () => Effect.succeed([]),
    });
    const LockTest = Layer.succeed(LockService, {
      acquire: () => Effect.succeed({ name: "diff", agentId: "test", acquiredAt: 0, lockId: "test-lock" }), release: () => Effect.void,
    });

    const report = await Effect.runPromise(diff({
      changedFiles: [before.path], baselinePath: ".openarch/baseline.json", agentId: "test",
      semanticProfiles: [{ file: before.path, changes: [{ anchor: "run", kind: "function_body" }], beforeMetrics: {
        weightedBranchTotal: before.branchCount, maxFuncBranch: before.maxFuncBranch, nestingDepth: before.nestingDepth,
        loc: before.loc!, externalPassthroughCalls: before.externalPassthroughCalls!,
      } }],
    }).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest))));

    expect(report.evidence.mrDetail[0]).toMatchObject({ scope: "existing", localBurden: { metrics: { branch: { delta: 2 }, nesting: { delta: 2 }, loc: { delta: 30 }, externalPassthrough: { delta: 2 } } }, exposure: { delta: null } });
    expect(report.summary.dMR).toBeGreaterThan(0);
  });

  it("keeps test-file complexity out of the production D_MR report and history", async () => {
    const testBefore = { ...before, path: "src/__tests__/dmr-sample.test.ts", fileKind: "test" as const };
    const testAfter = { ...after, path: testBefore.path };
    const histories: MRDiagnosis[][] = [];
    const ParserTest = Layer.succeed(ParserService, {
      parse: () => Effect.succeed(testAfter), query: () => Effect.succeed([]), supportedLanguages: Effect.succeed(["typescript"]),
    });
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: () => Effect.void,
      readIndex: () => Effect.succeed({
        version: "1",
        meta: { scanAt: "2026-07-11T00:00:00.000Z", snapshotSha256: "a".repeat(64), nFiles: 10, nProductionFiles: 9, nTestFiles: 1, languages: ["typescript"], p95: { branch: 10, nesting: 10, loc: 100, alpha: 1, oneMinusConnectedness: 1, externalPassthrough: 10 } },
      }),
      writeIndex: () => Effect.void, writeFileMetrics: () => Effect.void, deleteFileMetrics: () => Effect.void,
      readFileMetrics: () => Effect.succeed(testBefore), listAllFileMetrics: () => Effect.succeed([[testBefore.path, testBefore]]),
      clearFileMetrics: () => Effect.void,
      writeHistory: (_id, _deltas, _timestamp, diagnosis) => Effect.sync(() => { histories.push([...(diagnosis ?? [])]); }),
      readHistoryEntry: () => Effect.succeed(null),
      readAllHistory: () => Effect.succeed([]),
    });
    const LockTest = Layer.succeed(LockService, {
      acquire: () => Effect.succeed({ name: "diff", agentId: "test", acquiredAt: 0, lockId: "test-lock" }), release: () => Effect.void,
    });

    const report = await Effect.runPromise(diff({
      changedFiles: [testBefore.path], baselinePath: ".openarch/baseline.json", changeKind: "function_body", agentId: "test",
    }).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest))));

    expect(report.summary.dMR).toBe(0);
    expect(report.evidence.mrDetail).toEqual([]);
    expect(histories).toEqual([[]]);
  });

  it("does not read deleted files from disk when a manual fallback profile is supplied", async () => {
    const deletedPath = "src/deleted.ts";
    const parse = vi.fn(() => { throw new Error("deleted file must not be parsed from disk"); });
    const ParserTest = Layer.succeed(ParserService, {
      parse, query: () => Effect.succeed([]), supportedLanguages: Effect.succeed(["typescript"]),
    });
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: () => Effect.void,
      readIndex: () => Effect.succeed({ version: "1", meta: {
        scanAt: "2026-07-11T00:00:00.000Z", snapshotSha256: "a".repeat(64), nFiles: 10, nProductionFiles: 10, languages: ["typescript"],
        p95: { branch: 10, nesting: 10, loc: 100, alpha: 1, oneMinusConnectedness: 1, externalPassthrough: 10 },
      } }),
      writeIndex: () => Effect.void, writeFileMetrics: () => Effect.void, deleteFileMetrics: () => Effect.void,
      readFileMetrics: () => Effect.succeed(before), listAllFileMetrics: () => Effect.succeed([[before.path, before]]), clearFileMetrics: () => Effect.void,
      writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null), readAllHistory: () => Effect.succeed([]),
    });
    const LockTest = Layer.succeed(LockService, {
      acquire: () => Effect.succeed({ name: "diff", agentId: "test", acquiredAt: 0, lockId: "test-lock" }), release: () => Effect.void,
    });

    await withTemporaryDirectory("diff-deleted", async (cwd) => {
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
      try {
        const report = await Effect.runPromise(diff({
          changedFiles: [deletedPath], baselinePath: ".openarch/baseline.json", agentId: "test",
          semanticProfiles: [{ file: deletedPath, changes: [{ anchor: "manual:file", kind: "function_body" }], beforeState: "git", deleted: true }],
        }).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest))));

        expect(parse).not.toHaveBeenCalled();
        expect(report.summary.dMR).toBe(0);
        expect(report.summary.deltas).toEqual([]);
        expect(report.evidence.mrDetail).toEqual([]);
      } finally {
        cwdSpy.mockRestore();
      }
    });
  });

  it("replays a content-addressed diff without adding history or recalculating against its own writeback", async () => {
    let current: IndexEntry = before;
    let stored: StoredHistoryEntry | null = null;
    let historyWrites = 0;
    let metricWrites = 0;
    const ParserTest = Layer.succeed(ParserService, {
      parse: () => Effect.succeed(after), query: () => Effect.succeed([]), supportedLanguages: Effect.succeed(["typescript"]),
    });
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: () => Effect.void,
      readIndex: () => Effect.succeed({ version: "1", meta: {
        scanAt: "2026-07-11T00:00:00.000Z", snapshotSha256: "a".repeat(64), nFiles: 10, nProductionFiles: 10, languages: ["typescript"],
        p95: { branch: 10, nesting: 10, loc: 100, alpha: 1, oneMinusConnectedness: 1, externalPassthrough: 10 },
      } }),
      writeIndex: () => Effect.void,
      writeFileMetrics: (_path, entry) => Effect.sync(() => { current = entry; metricWrites += 1; }), deleteFileMetrics: () => Effect.void,
      readFileMetrics: () => Effect.succeed(current), listAllFileMetrics: () => Effect.succeed([[before.path, current]]), clearFileMetrics: () => Effect.void,
      writeHistory: (entryId, deltas, timestamp, diagnosis, evidence) => Effect.sync(() => {
        if (stored) return;
        stored = { entryId, timestamp, deltas, diagnosis, evidence };
        historyWrites += 1;
      }),
      readHistoryEntry: () => Effect.succeed(stored),
      readAllHistory: () => Effect.succeed(stored ? [[stored.timestamp, stored.deltas] as const] : []),
    });
    const LockTest = Layer.succeed(LockService, {
      acquire: () => Effect.succeed({ name: "diff", agentId: "test", acquiredAt: 0, lockId: "test-lock" }), release: () => Effect.void,
    });
    const input = { changedFiles: [before.path], baselinePath: ".openarch/baseline.json", changeKind: "function_body" as const, agentId: "test" };
    const first = await Effect.runPromise(diff(input).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest))));
    const second = await Effect.runPromise(diff(input).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest))));

    expect(second.summary.historyEntryId).toBe(first.summary.historyEntryId);
    expect(second.summary.dMR).toBe(first.summary.dMR);
    expect(second.evidence.mrDetail).toEqual(first.evidence.mrDetail);
    expect(second.summary.deltas).toEqual(first.summary.deltas);
    expect(historyWrites).toBe(1);
    expect(metricWrites).toBe(0);
  });
});
