import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { resolve } from "node:path";
import { testGovernance } from "../../src/application/testGovernance";
import { ParserService } from "../../src/port/ParserService";
import { StorageService } from "../../src/port/StorageService";
import { LockService } from "../../src/port/LockService";

describe("testGovernance application", () => {
  it("keeps provider facts and policy verdicts separate in read-only reporting mode", async () => {
    const subjectPath = resolve("packages/core/src/domain/subject.ts").replace(/\\/g, "/");
    const written: Array<Record<string, unknown>> = [];
    const ParserTest = Layer.succeed(ParserService, {
      parse: (path) => Effect.succeed({
        path, language: "typescript" as const, branchCount: 0, nestingDepth: 0, functionCount: 0,
        passthroughCalls: 0, imports: [{ resolvedPath: subjectPath, source: "../../src/domain/subject" }], functions: [],
      }), query: () => Effect.succeed([]), supportedLanguages: Effect.succeed(["typescript"]),
    });
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: () => Effect.void, readIndex: () => Effect.succeed(null), writeIndex: () => Effect.void,
      writeFileMetrics: (_path, entry) => Effect.sync(() => { written.push(entry); }), deleteFileMetrics: () => Effect.void, readFileMetrics: () => Effect.succeed(null),
      listAllFileMetrics: () => Effect.succeed([["packages/core/__tests__/empty.test.ts", {
        path: "packages/core/__tests__/empty.test.ts", fileKind: "test" as const,
        branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0,
      }], [subjectPath, {
        path: subjectPath, fileKind: "production" as const,
        branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0,
      }], ["services/coordination/internal/evidence/sample_test.go", {
        path: "services/coordination/internal/evidence/sample_test.go", fileKind: "test" as const,
        branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0,
      }]]),
      clearFileMetrics: () => Effect.void, writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null), readAllHistory: () => Effect.succeed([]),
    });
    const LockTest = Layer.succeed(LockService, {
      acquire: () => Effect.succeed({ name: "governance-state-write", agentId: "test", acquiredAt: 0, lockId: "test-lock" }),
      release: () => Effect.void,
    });
    const report = await Effect.runPromise(testGovernance({
      providerIds: ["typescript-vitest"], policy: { rules: {} }, rules: [], persistence: "read",
      discoveredTestFiles: ["packages/core/__tests__/empty.test.ts", "services/coordination/internal/evidence/sample_test.go", "packages/core/__tests__/new.test.ts"],
    }).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest))));
    expect(report.decision.verdict).toBe("PASS");
    expect(report.collection.coverage).toEqual({
      status: "partial",
      reasons: ["test_files_missing_from_baseline", "test_files_unrecognized"],
      testFiles: 3,
      unbaselinedTestFiles: [expect.stringMatching(/packages\/core\/__tests__\/new\.test\.ts$/)],
      providerHandledTestFiles: ["packages/core/__tests__/empty.test.ts"],
      unrecognizedTestFiles: ["services/coordination/internal/evidence/sample_test.go"],
      failedTestFiles: [],
    });
    expect(report.collection.providersRun).toEqual(["typescript-vitest"]);
    expect(report.collection.providerCoverage).toEqual([{
      providerId: "typescript-vitest",
      status: "partial",
      reasons: ["test_files_missing_from_baseline"],
      candidateTestFiles: ["packages/core/__tests__/empty.test.ts"],
      unbaselinedTestFiles: [expect.stringMatching(/packages\/core\/__tests__\/new\.test\.ts$/)],
      providerHandledTestFiles: ["packages/core/__tests__/empty.test.ts"],
      failedTestFiles: [],
    }]);
    expect(report.collection.providerSummaries).toEqual([{ providerId: "typescript-vitest", testFiles: 1, testCases: 0, p95: undefined }]);
    expect(report.collection.testCaseSpans).toMatchObject({ availability: "partial", value: [] });
    expect(report.collection.unrecognizedTestFiles).toEqual(["services/coordination/internal/evidence/sample_test.go"]);
    expect(report.collection.staticModuleAssociations).toEqual([{
      testFile: "packages/core/__tests__/empty.test.ts",
      association: { targetPath: subjectPath, source: "../../src/domain/subject", confidence: "low" },
    }]);
    expect(report.collection.associationUnavailableTestFiles).toEqual([]);
    expect(written).toEqual([]);
  });
});
