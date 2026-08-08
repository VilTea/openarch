import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { rebuildGraph } from "../../src/application/diffGraph";
import { toAbsolute } from "../../src/infra/paths";
import type { StorageService } from "../../src/port/StorageService";

describe("rebuildGraph file participation", () => {
  it("uses the participation contract for explicit and legacy baseline roles", async () => {
    const storage = {
      listAllFileMetrics: () => Effect.succeed([
        ["src/legacy.test.ts", { path: "src/legacy.test.ts", imports: ["src/consumer.ts"], branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0 }],
        ["src/explicit.test.ts", { path: "src/explicit.test.ts", fileKind: "test", imports: ["src/consumer.ts"], branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0 }],
      ]),
    } as unknown as StorageService;

    const graph = await Effect.runPromise(rebuildGraph([], storage));

    expect(graph.graph.has(toAbsolute("src/legacy.test.ts"))).toBe(true);
    expect(graph.graph.has(toAbsolute("src/explicit.test.ts"))).toBe(false);
  });
});
