import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { review } from "../../../src/application/governance/review";
import { StorageService } from "../../../src/port/StorageService";

describe("review", () => {
  it("projects observed baseline facts and sealed history through StorageService", async () => {
    const StorageTest = Layer.succeed(StorageService, {
      readIndex: () => Effect.succeed({
        version: "5.2",
        meta: {
          scanAt: "2026-07-22T00:00:00.000Z", nFiles: 2, languages: ["typescript"],
          p95: { branch: 5, nesting: 4, loc: 20, alpha: 0.5, oneMinusConnectedness: 0.5, externalPassthrough: 4 },
        },
      }),
      listAllFileMetrics: () => Effect.succeed([["src/a.ts", {
        path: "src/a.ts", branchCount: 3, nestingDepth: 1, inDegree: 0, outDegree: 0,
        alphaStruct: 0.2, maxFuncBranch: 3, loc: 10, externalPassthroughCalls: 2, connectedness: 1,
      }], ["fixtures/high-load.ts", {
        path: "fixtures/high-load.ts", fileKind: "auxiliary", branchCount: 99, nestingDepth: 20, inDegree: 0, outDegree: 0,
        alphaStruct: 1, maxFuncBranch: 99, loc: 999, externalPassthroughCalls: 99, connectedness: 0,
      }]]),
      readAllHistory: () => Effect.succeed([["2026-07-22T00:00:00.000Z", [
        { file: "src/a.ts", deltaI: 8 }, { file: "fixtures/high-load.ts", deltaI: 800 },
      ]]]),
    } as never);

    const result = await Effect.runPromise(review().pipe(Effect.provide(StorageTest)));
    expect(result).toMatchObject({ nFiles: 1, hasData: true, top3: [expect.objectContaining({ path: "src/a.ts", crl: expect.any(Number) })] });
    expect(result.entries).toEqual([expect.objectContaining({ path: "src/a.ts" })]);
  });

  it("keeps unreadable storage as an unavailable structural review", async () => {
    const StorageTest = Layer.succeed(StorageService, {
      readIndex: () => Effect.fail(new Error("baseline unavailable") as never),
      listAllFileMetrics: () => Effect.succeed([]),
      readAllHistory: () => Effect.succeed([]),
    } as never);
    const result = await Effect.runPromise(review().pipe(Effect.provide(StorageTest)));
    expect(result).toEqual({ nFiles: 0, entries: [], top3: [], hasData: false });
  });
});
