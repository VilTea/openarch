import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { scan } from "../../src/application/scan";
import { ParserService } from "../../src/port/ParserService";
import { StorageService } from "../../src/port/StorageService";
import { LockService } from "../../src/port/LockService";
import type { FileAst } from "../../src/domain/ast";
import { createAnalysisScope } from "../../src/domain/analysisScope";
import { METRIC_CONTRACT_VERSION } from "../../src/domain/metricCatalog";
import { ScanProgressService } from "../../src/port/ScanProgressService";
import { DEFAULT_CRL_STATE_WEIGHTS } from "../../src/domain/crlState";

const mockAst = (path: string, imports: string[] = []): FileAst => ({
  path,
  language: "typescript",
  branchCount: 1,
  nestingDepth: 1,
  functionCount: 1,
  passthroughCalls: 0,
  imports: imports.map((p) => ({ resolvedPath: p, source: p })),
  functions: [],
});

const LockTest = Layer.succeed(LockService, {
  acquire: () => Effect.succeed({ name: "governance-state-write", agentId: "test", acquiredAt: 0, lockId: "test-lock" }),
  release: () => Effect.void,
});
const ScanProgressTest = Layer.succeed(ScanProgressService, { write: () => Effect.void, read: () => Effect.succeed(null) });

describe("scan application", () => {
  it("解析 N 文件 + 写 per-file + index 路径清单", async () => {
    const ParserTest = Layer.succeed(ParserService, {
      parse: (p) => Effect.succeed(mockAst(p, p === "a.ts" ? ["b.ts"] : [])),
      query: () => Effect.succeed([]),
      supportedLanguages: Effect.succeed(["typescript"]),
    });
    const StorageTest = Layer.succeed(StorageService, {
      readBaseline: () => Effect.fail(new Error("not used") as never),
      writeBaseline: (_p, _b) => Effect.void,
      readIndex: () => Effect.succeed(null),
      writeIndex: (_idx) => Effect.void,
      writeFileMetrics: (_p, _e) => Effect.void, deleteFileMetrics: () => Effect.void,
      readFileMetrics: (_p) => Effect.succeed(null),
      listAllFileMetrics: () => Effect.succeed([]),
      clearFileMetrics: () => Effect.void,
      writeHistory: (_id, _d, _ts) => Effect.void, readHistoryEntry: () => Effect.succeed(null),
      readAllHistory: () => Effect.succeed([]),
    });

    const result = await Effect.runPromise(
      scan(["a.ts", "b.ts"]).pipe(
        Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest, ScanProgressTest))
      )
    );

    expect(result.nFiles).toBe(2);
  });

  it("零文件 → nFiles=0，不写 index（防 nFiles=0 污染）", async () => {
    const writeIndexCalls: unknown[] = [];
    const StorageTest = Layer.succeed(StorageService, {
      readBaseline: () => Effect.fail(new Error("not used") as never),
      writeBaseline: () => Effect.void,
      readIndex: () => Effect.succeed(null),
      writeIndex: (idx) => { writeIndexCalls.push(idx); return Effect.void; },
      writeFileMetrics: () => Effect.void, deleteFileMetrics: () => Effect.void,
      readFileMetrics: () => Effect.succeed(null),
      listAllFileMetrics: () => Effect.succeed([]),
      clearFileMetrics: () => Effect.void,
      writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null),
      readAllHistory: () => Effect.succeed([]),
    });
    const ParserTest = Layer.succeed(ParserService, {
      parse: () => Effect.die("不应被调用"),
      supportedLanguages: Effect.succeed(["typescript"]),
    });

    const result = await Effect.runPromise(
      scan([]).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest, ScanProgressTest)))
    );
    expect(result.nFiles).toBe(0);
    expect(writeIndexCalls).toHaveLength(0);  // 空输入不写 index
  });

  it("parse 失败 → 错误传播，不写 per-file", async () => {
    const writeCalls: string[] = [];
    const progress: Array<{ status: string; phase: string; completed: number; reason?: string }> = [];
    const ProgressTest = Layer.succeed(ScanProgressService, {
      write: (entry) => Effect.sync(() => { progress.push(entry); }), read: () => Effect.succeed(null),
    });
    const StorageTest = Layer.succeed(StorageService, {
      readBaseline: () => Effect.fail(new Error("not used") as never),
      writeBaseline: () => Effect.void,
      readIndex: () => Effect.succeed(null),
      writeIndex: () => Effect.void,
      writeFileMetrics: (p) => { writeCalls.push(p); return Effect.void; }, deleteFileMetrics: () => Effect.void,
      readFileMetrics: () => Effect.succeed(null),
      listAllFileMetrics: () => Effect.succeed([]),
      clearFileMetrics: () => Effect.void,
      writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null),
      readAllHistory: () => Effect.succeed([]),
    });
    const ParserTest = Layer.succeed(ParserService, {
      parse: (p) => p === "bad.ts"
        ? Effect.fail(new Error("syntax error") as never)
        : Effect.succeed(mockAst(p)),
      supportedLanguages: Effect.succeed(["typescript"]),
    });

    const either = await Effect.runPromise(
      scan(["bad.ts", "good.ts"]).pipe(
        Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest, ProgressTest)),
        Effect.either,
      )
    );
    expect(either._tag).toBe("Left");          // parse 错误传播
    expect(writeCalls).toHaveLength(0);         // 未写任何 per-file
    expect(progress.at(-1)).toMatchObject({ status: "failed", phase: "parsing", completed: 1, reason: "syntax error" });
  });

  it("scan 以一个完整 snapshot 发布，不先清空当前 baseline", async () => {
    const calls: string[] = [];
    const StorageTest = Layer.succeed(StorageService, {
      readBaseline: () => Effect.fail(new Error("not used") as never),
      writeBaseline: () => Effect.sync(() => { calls.push("publish"); }),
      readIndex: () => Effect.succeed(null),
      writeIndex: () => Effect.void,
      writeFileMetrics: () => Effect.void, deleteFileMetrics: () => Effect.void,
      readFileMetrics: () => Effect.succeed(null),
      listAllFileMetrics: () => Effect.succeed([]),
      clearFileMetrics: () => Effect.sync(() => { calls.push("clear"); }),
      clearPendingDiff: () => Effect.sync(() => { calls.push("clear-pending"); }),
      writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null),
      readAllHistory: () => Effect.succeed([]),
    });
    const ParserTest = Layer.succeed(ParserService, {
      parse: (p) => Effect.succeed(mockAst(p)),
      supportedLanguages: Effect.succeed(["typescript"]),
    });

    await Effect.runPromise(
      scan(["a.ts"]).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest, ScanProgressTest)))
    );
    expect(calls).toEqual(["publish", "clear-pending"]);
  });

  it("测试文件进入 baseline，但不参与生产 P95 和依赖图", async () => {
    const entries: Array<Record<string, unknown>> = [];
    const indexes: Array<{ meta: { nFiles: number; nProductionFiles?: number; nTestFiles?: number; p95?: { branch: number } } }> = [];
    const ParserTest = Layer.succeed(ParserService, {
      parse: (p) => Effect.succeed({ ...mockAst(p), branchCount: p.includes("__tests__") ? 99 : 2 }),
      query: () => Effect.succeed([]),
      supportedLanguages: Effect.succeed(["typescript"]),
    });
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: (snapshot) => Effect.sync(() => { entries.push(...snapshot.entries); indexes.push(snapshot.index); }), readIndex: () => Effect.succeed(null),
      writeIndex: () => Effect.void,
      writeFileMetrics: () => Effect.void, deleteFileMetrics: () => Effect.void,
      readFileMetrics: () => Effect.succeed(null), listAllFileMetrics: () => Effect.succeed([]),
      clearFileMetrics: () => Effect.void, writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null), readAllHistory: () => Effect.succeed([]),
    });
    await Effect.runPromise(scan(["src/a.ts", "src/__tests__/a.test.ts"]).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest, ScanProgressTest))));
    expect(entries.map((entry) => entry.fileKind)).toEqual(["production", "test"]);
    expect(indexes[0].meta).toMatchObject({ nFiles: 2, nProductionFiles: 1, nTestFiles: 1 });
    expect(indexes[0].meta.p95?.branch).toBe(2);
  });

  it("重建基线时保留既有的测试 provider 指标", async () => {
    const written: Array<Record<string, unknown>> = [];
    const previous = {
      path: "src/__tests__/a.test.ts", fileKind: "test" as const, branchCount: 0, nestingDepth: 0,
      inDegree: 0, outDegree: 0, alphaStruct: 0,
      testMetrics: { schemaVersion: "1" as const, providerId: "typescript-vitest", tests: [], findings: [] },
    };
    const ParserTest = Layer.succeed(ParserService, {
      parse: (p) => Effect.succeed(mockAst(p)), query: () => Effect.succeed([]), supportedLanguages: Effect.succeed(["typescript"]),
    });
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: (snapshot) => Effect.sync(() => { written.push(...snapshot.entries); }), readIndex: () => Effect.succeed(null), writeIndex: () => Effect.void,
      writeFileMetrics: () => Effect.void, deleteFileMetrics: () => Effect.void, readFileMetrics: () => Effect.succeed(null),
      listAllFileMetrics: () => Effect.succeed([[previous.path, previous]]), clearFileMetrics: () => Effect.void,
      writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null), readAllHistory: () => Effect.succeed([]),
    });
    await Effect.runPromise(scan([previous.path]).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest, ScanProgressTest))));
    expect(written[0].testMetrics).toEqual(previous.testMetrics);
  });

  it("重复 scan 保留 calibration 对，避免吞掉 denominator-only shift", async () => {
    const snapshots: Array<{ entries: readonly Record<string, unknown>[]; index: { meta: Record<string, unknown> } }> = [];
    let previousIndex: { meta: Record<string, unknown> } | null = null;
    let entries: ReadonlyArray<readonly [string, Record<string, unknown>]> = [];
    const ParserTest = Layer.succeed(ParserService, {
      parse: (path) => Effect.succeed(mockAst(path)), query: () => Effect.succeed([]), supportedLanguages: Effect.succeed(["typescript"]),
    });
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: (snapshot) => Effect.sync(() => {
        snapshots.push(snapshot as unknown as { entries: readonly Record<string, unknown>[]; index: { meta: Record<string, unknown> } });
        previousIndex = snapshot.index as unknown as { meta: Record<string, unknown> };
        entries = snapshot.entries.map((entry) => [entry.path, entry] as const);
      }),
      readIndex: () => Effect.succeed(previousIndex as never), writeIndex: () => Effect.void,
      writeFileMetrics: () => Effect.void, deleteFileMetrics: () => Effect.void, readFileMetrics: () => Effect.succeed(null),
      listAllFileMetrics: () => Effect.succeed(entries as never), clearFileMetrics: () => Effect.void,
      writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null), readAllHistory: () => Effect.succeed([]),
    });
    const layer = Layer.mergeAll(ParserTest, StorageTest, LockTest, ScanProgressTest);

    await Effect.runPromise(scan(["a.ts"]).pipe(Effect.provide(layer)));
    await Effect.runPromise(scan(["a.ts"]).pipe(Effect.provide(layer)));

    expect(snapshots[1].index.meta.calibration).toEqual(snapshots[0].index.meta.calibration);
  });

  it("calibrates independent same-language policy scopes instead of collapsing them", async () => {
    const indexes: Array<{ meta: { languages: readonly string[]; policyCalibrations?: Record<string, unknown> } }> = [];
    const ParserTest = Layer.succeed(ParserService, {
      parse: (path) => Effect.succeed({ ...mockAst(path), language: "go" as const }),
      query: () => Effect.succeed([]),
      supportedLanguages: Effect.succeed(["go"]),
    });
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: (snapshot) => Effect.sync(() => { indexes.push(snapshot.index); }),
      readIndex: () => Effect.succeed(null),
      writeIndex: (index) => Effect.sync(() => { indexes.push(index); }),
      writeFileMetrics: () => Effect.void, deleteFileMetrics: () => Effect.void,
      readFileMetrics: () => Effect.succeed(null),
      listAllFileMetrics: () => Effect.succeed([]),
      clearFileMetrics: () => Effect.void,
      writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null),
      readAllHistory: () => Effect.succeed([]),
    });

    await Effect.runPromise(scan(["services/alpha/main.go", "services/beta/main.go"], undefined, {
      structuralPolicies: [
        { id: "alpha", languages: ["go"], scope: { include: ["services/alpha/**"] }, mode: "enforce", rules: [], crlStateWeights: DEFAULT_CRL_STATE_WEIGHTS },
        { id: "beta", languages: ["go"], scope: { include: ["services/beta/**"] }, mode: "observe", rules: [], crlStateWeights: DEFAULT_CRL_STATE_WEIGHTS },
      ],
    }).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest, ScanProgressTest))));
    expect(indexes[0].meta.languages).toEqual(["go"]);
    expect(Object.keys(indexes[0].meta.policyCalibrations ?? {})).toEqual(["alpha", "beta"]);
  });

  it("写入完整分析范围和 metric contract，手动子集显式标不完整", async () => {
    const indexes: Array<{ meta: { analysisScope?: { fingerprint: string; complete: boolean }; metricContractVersion?: string } }> = [];
    const ParserTest = Layer.succeed(ParserService, { parse: (path) => Effect.succeed(mockAst(path)), query: () => Effect.succeed([]), supportedLanguages: Effect.succeed(["typescript"]) });
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: (snapshot) => Effect.sync(() => { indexes.push(snapshot.index); }), readIndex: () => Effect.succeed(null), writeIndex: () => Effect.void,
      writeFileMetrics: () => Effect.void, deleteFileMetrics: () => Effect.void, readFileMetrics: () => Effect.succeed(null), listAllFileMetrics: () => Effect.succeed([]), clearFileMetrics: () => Effect.void, writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null), readAllHistory: () => Effect.succeed([]),
    });
    await Effect.runPromise(scan(["a.ts"], undefined, { analysisScope: createAnalysisScope(["typescript"]), completeScope: false, sourceSnapshotSha256: "a".repeat(64) }).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest, ScanProgressTest))));
    expect(indexes[0].meta.analysisScope?.complete).toBe(false);
    expect(indexes[0].meta.metricContractVersion).toBe(METRIC_CONTRACT_VERSION);
    expect(indexes[0].meta.sourceSnapshotSha256).toBeUndefined();
  });

  it("stores caller-provided source identity only for a complete scan", async () => {
    const indexes: Array<{ meta: { sourceSnapshotSha256?: string } }> = [];
    const ParserTest = Layer.succeed(ParserService, { parse: (path) => Effect.succeed(mockAst(path)), query: () => Effect.succeed([]), supportedLanguages: Effect.succeed(["typescript"]) });
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: (snapshot) => Effect.sync(() => { indexes.push(snapshot.index); }), readIndex: () => Effect.succeed(null), writeIndex: () => Effect.void,
      writeFileMetrics: () => Effect.void, deleteFileMetrics: () => Effect.void, readFileMetrics: () => Effect.succeed(null), listAllFileMetrics: () => Effect.succeed([]), clearFileMetrics: () => Effect.void, writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null), readAllHistory: () => Effect.succeed([]),
    });
    await Effect.runPromise(scan(["a.ts"], undefined, { sourceSnapshotSha256: "a".repeat(64) }).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest, ScanProgressTest))));
    expect(indexes[0].meta.sourceSnapshotSha256).toBe("a".repeat(64));
  });

  it("file-kind policy 属于分析范围，策略变更会改变 fingerprint", () => {
    expect(createAnalysisScope(["typescript"], [{ pattern: "samples/**", kind: "auxiliary" }]).fingerprint)
      .not.toBe(createAnalysisScope(["typescript"]).fingerprint);
  });
});
