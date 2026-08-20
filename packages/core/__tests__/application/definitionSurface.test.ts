import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTemporaryDirectory } from "../support/temporaryDirectory";
import { definitionSurfaceSimilarityGroups } from "../../src/application/definitionSurfaceFacts";
import { definitionSurfaceCandidateMetrics, definitionSurfaceCandidatePaths } from "../../src/application/definitionSurfaceCandidates";
import { assessDefinitionSurfaceContracts, type DefinitionSurfaceContract } from "../../src/application/definitionSurfaceContracts";

const semanticContract = (): DefinitionSurfaceContract => ({
  id: "semantic-relations-lsp-pipeline",
  description: "semantic relation providers must use the shared pipeline",
  roleGlobs: ["**/*SemanticRelationProvider.ts"],
  authorityGlobs: ["**/semanticRelationPipeline.ts"],
  requiredImport: "./semanticRelationPipeline",
});

describe("definitionSurfaceCandidates", () => {
  it("selects files above both language P95s", () => {
    const metrics = Array.from({ length: 21 }, (_, i) => ({
      path: `src/mod${i}.ts`, language: "typescript", loc: 200 + i, declarationLoc: 10 + (i + 1) * 10,
    }));
    const selected = definitionSurfaceCandidateMetrics(metrics);
    expect(selected.map((metric) => metric.path)).toContain("src/mod20.ts");
    expect(selected.map((metric) => metric.path)).not.toContain("src/mod18.ts");
    expect(definitionSurfaceCandidatePaths(metrics)).toContain("src/mod20.ts");
  });
});

describe("definitionSurfaceSimilarityGroups", () => {
  it("groups two files sharing a repeated implementation block", async () => {
    await withTemporaryDirectory("definition-surface-similarity", (cwd) => {
      const a = join(cwd, "a.ts");
      const b = join(cwd, "b.ts");
      const block = [
        "export const collect = async (input: string) => {",
        "  const items = await fetch(input);",
        "  const rows = await items.json();",
        "  return rows.filter((row) => row.active);",
        "};",
        "",
        "export const resolve = async (row: { id: number }) => {",
        "  const target = await fetch(`/api/${row.id}`);",
        "  return target.json();",
        "};",
      ].join("\n");
      writeFileSync(a, `${block}\n\nexport const aOnly = 1;\n`, "utf8");
      writeFileSync(b, `${block}\n\nexport const bOnly = 2;\n`, "utf8");
      const groups = definitionSurfaceSimilarityGroups([a, b], { blockWindow: 6, threshold: 0.7, projectRoot: cwd });
      expect(groups).toHaveLength(1);
      expect(groups[0]!.files).toEqual(["a.ts", "b.ts"]);
      expect(groups[0]!.repeatedBlockLines).toBeGreaterThan(0);
    });
  });

  it("returns no groups for unrelated files", async () => {
    await withTemporaryDirectory("definition-surface-unrelated", (cwd) => {
      const a = join(cwd, "a.ts");
      const b = join(cwd, "b.ts");
      writeFileSync(a, "export const alpha = () => 1;\n", "utf8");
      writeFileSync(b, "export const beta = () => 2;\n", "utf8");
      expect(definitionSurfaceSimilarityGroups([a, b], { blockWindow: 4, threshold: 0.8 })).toEqual([]);
    });
  });
});

describe("definitionSurfaceContracts", () => {
  it("flags a role file that bypasses the shared authority module", async () => {
    await withTemporaryDirectory("definition-surface-contract", (cwd) => {
      const provider = join(cwd, "LegacySemanticRelationProvider.ts");
      const pipeline = join(cwd, "semanticRelationPipeline.ts");
      writeFileSync(provider, "export const collect = async () => { return []; };\n", "utf8");
      writeFileSync(pipeline, "export const runLspResolutionPipeline = async () => {};\n", "utf8");
      const findings = assessDefinitionSurfaceContracts(cwd, [provider, pipeline], [semanticContract()]);
      expect(findings).toEqual([
        expect.objectContaining({
          contractId: "semantic-relations-lsp-pipeline",
          file: "LegacySemanticRelationProvider.ts",
          authorityPath: "semanticRelationPipeline.ts",
        }),
      ]);
    });
  });

  it("does not flag role files when the authority file is absent", async () => {
    await withTemporaryDirectory("definition-surface-contract-no-authority", (cwd) => {
      const provider = join(cwd, "LegacySemanticRelationProvider.ts");
      writeFileSync(provider, "export const collect = async () => { return []; };\n", "utf8");
      const findings = assessDefinitionSurfaceContracts(cwd, [provider], [semanticContract()]);
      expect(findings).toEqual([]);
    });
  });

  it("accepts a role file that imports the required authority module", async () => {
    await withTemporaryDirectory("definition-surface-contract-ok", (cwd) => {
      const provider = join(cwd, "ModernSemanticRelationProvider.ts");
      const pipeline = join(cwd, "semanticRelationPipeline.ts");
      writeFileSync(provider, 'import { runLspResolutionPipeline } from "./semanticRelationPipeline";\n', "utf8");
      writeFileSync(pipeline, "export const runLspResolutionPipeline = async () => {};\n", "utf8");
      const findings = assessDefinitionSurfaceContracts(cwd, [provider, pipeline], [semanticContract()]);
      expect(findings).toEqual([]);
    });
  });
});
