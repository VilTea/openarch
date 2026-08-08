import { describe, expect, it } from "vitest";
import { executeRule } from "../../src/implicit-deps/engine";
import { emptyProjectFacts, type ChangeSurfaceFact, type ProjectFacts, type StructureMetricFact } from "../../src/script-runtime/projectFacts";

/** 示例规则 no-unlinked-consumer：变更符号被消费者引用，但消费者未 import 变更文件 → 隐式依赖候选。 */
const noUnlinkedConsumerRule = {
  requires: ["change-surface.v1", "structure-metrics.v1"],
  stages: { text: ({ files }: { files: readonly string[] }) => [...files] },
  link: ({ facts }: { facts: ProjectFacts }) => {
    const surface = facts.changeSurface;
    if (surface.availability !== "available") throw new Error("change-surface.v1 unavailable");
    const metrics = facts.structureMetrics;
    if (metrics.availability !== "available") throw new Error("structure-metrics.v1 unavailable");
    const importsByFile = new Map(metrics.value.map((metric) => [metric.repositoryPath, metric.imports ?? []]));
    const edges: Array<{ from: string; to: string; via: string; type: string }> = [];
    for (const symbol of surface.value.changedSymbols) {
      for (const consumer of symbol.consumers) {
        const imports = importsByFile.get(consumer) ?? [];
        const changedStem = symbol.file.replace(/\.(ts|tsx|js|mjs|rs|go|py|java)$/, "");
        if (!imports.some((source) => source === changedStem || source.startsWith(`${changedStem}/`))) {
          edges.push({ from: consumer, to: symbol.file, via: "change-surface", type: "implicit_dependency" });
        }
      }
    }
    return edges;
  },
};

const metric = (repositoryPath: string, imports: readonly string[]): StructureMetricFact => ({
  path: repositoryPath, repositoryPath,
  branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: imports.length, alphaStruct: 0.1, imports,
});

const factsWith = (changeSurface: ChangeSurfaceFact, metrics: readonly StructureMetricFact[]): ProjectFacts => ({
  ...emptyProjectFacts(),
  structureMetrics: { availability: "available", value: metrics },
  changeSurface: { availability: "available", value: changeSurface },
});

describe("change-surface.v1 隐式依赖规则（no-unlinked-consumer）", () => {
  it("消费者未 import 变更文件 → 产出隐式依赖候选边", async () => {
    const { edges, error, unavailable } = await executeRule(
      "no-unlinked-consumer.mjs",
      ["src/api.ts", "src/client.ts", "src/unrelated.ts"],
      {} as never,
      async () => ({ default: noUnlinkedConsumerRule }),
      {
        facts: factsWith(
          { schemaVersion: 1, languages: ["typescript"], changedSymbols: [{ file: "src/api.ts", anchor: "Api.publish", kind: "public_method_sig", consumers: ["src/client.ts"] }] },
          [metric("src/api.ts", ["src/unrelated.ts"]), metric("src/client.ts", ["src/unrelated.ts"])],
        ),
      },
    );
    expect(error).toBeUndefined();
    expect(unavailable).toBeUndefined();
    expect(edges).toEqual([{ from: "src/client.ts", to: "src/api.ts", via: "change-surface", type: "implicit_dependency" }]);
  });

  it("消费者已 import 变更文件 → 不产出边", async () => {
    const { edges } = await executeRule(
      "no-unlinked-consumer.mjs",
      ["src/api.ts", "src/client.ts"],
      {} as never,
      async () => ({ default: noUnlinkedConsumerRule }),
      {
        facts: factsWith(
          { schemaVersion: 1, languages: ["typescript"], changedSymbols: [{ file: "src/api.ts", anchor: "Api.publish", kind: "public_method_sig", consumers: ["src/client.ts"] }] },
          [metric("src/api.ts", []), metric("src/client.ts", ["src/api"])],
        ),
      },
    );
    expect(edges).toEqual([]);
  });

  it("change-surface.v1 不可用时规则不执行（unavailable，非静默 clean）", async () => {
    const { edges, unavailable } = await executeRule(
      "no-unlinked-consumer.mjs",
      ["src/api.ts"],
      {} as never,
      async () => ({ default: noUnlinkedConsumerRule }),
      { facts: emptyProjectFacts() },
    );
    expect(edges).toEqual([]);
    expect(unavailable).toContain("change-surface.v1 is unavailable");
  });
});
