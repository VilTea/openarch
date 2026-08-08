import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { evolutionReview } from "../../src/application/evolutionReview";
import { ParserService } from "../../src/port/ParserService";
import { StorageService } from "../../src/port/StorageService";

describe("evolutionReview", () => {
  it("requires a fresh baseline instead of treating legacy flat imports as implementation evidence", async () => {
    const parser = Layer.succeed(ParserService, {
      parse: () => Effect.die("legacy relation facts must stop before parser enrichment"),
      query: () => Effect.succeed([]),
      supportedLanguages: Effect.succeed(["typescript"]),
    });
    const storage = Layer.succeed(StorageService, {
      listAllFileMetrics: () => Effect.succeed([[
        "src/barrel.ts",
        { path: "src/barrel.ts", branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 1, alphaStruct: 0, imports: ["src/member.ts"] },
      ]]),
    });

    const report = await Effect.runPromise(
      evolutionReview(process.cwd(), []).pipe(Effect.provide(Layer.mergeAll(parser, storage))),
    );

    expect(report.relationFacts).toEqual(expect.objectContaining({ availability: "unavailable" }));
    expect(report.coordinationCandidates).toEqual([]);
    expect(report.extensionSurfaces).toEqual(expect.objectContaining({ availability: "unavailable" }));
    expect(report.cochangeSets).toEqual(expect.objectContaining({ availability: "unavailable" }));
  });
});
