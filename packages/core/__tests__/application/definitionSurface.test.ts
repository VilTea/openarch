import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { ParserService, type ParserService as ParserServiceShape } from "../../src/port/ParserService";
import { withTemporaryDirectory } from "../support/temporaryDirectory";
import { definitionSurfaceSimilarityGroups } from "../../src/application/definitionSurfaceFacts";
import { definitionSurfaceCandidateMetrics, definitionSurfaceCandidatePaths } from "../../src/application/definitionSurfaceCandidates";
import { assessDefinitionSurfaceContracts, type DefinitionSurfaceContract } from "../../src/application/definitionSurfaceContracts";

/** 只提供契约判定需要的语法事实：`FileAst.imports[].source`。 */
const parserWithImports = (importsByFile: Readonly<Record<string, readonly string[]>>): ParserServiceShape => ({
  parse: (path) => {
    const sources = importsByFile[path];
    if (!sources) return Effect.die(`unexpected parse: ${path}`);
    return Effect.succeed({
      path,
      language: "typescript" as const,
      branchCount: 0,
      nestingDepth: 0,
      functionCount: 0,
      passthroughCalls: 0,
      imports: sources.map((source) => ({ source, resolvedPath: null })),
      loc: 1,
      functions: [],
    });
  },
  parseText: () => Effect.die("not used"),
  query: () => Effect.die("not used"),
  supportedLanguages: Effect.succeed(["typescript"] as const),
});

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
      const findings = assessDefinitionSurfaceContracts(cwd, [provider, pipeline], [semanticContract()], parserWithImports({
        [provider]: [],
        [pipeline]: [],
      }));
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
      const findings = assessDefinitionSurfaceContracts(cwd, [provider], [semanticContract()], parserWithImports({ [provider]: [] }));
      expect(findings).toEqual([]);
    });
  });

  it("accepts a role file that imports the required authority module", async () => {
    await withTemporaryDirectory("definition-surface-contract-ok", (cwd) => {
      const provider = join(cwd, "ModernSemanticRelationProvider.ts");
      const pipeline = join(cwd, "semanticRelationPipeline.ts");
      writeFileSync(provider, 'import { runLspResolutionPipeline } from "./semanticRelationPipeline";\n', "utf8");
      writeFileSync(pipeline, "export const runLspResolutionPipeline = async () => {};\n", "utf8");
      const findings = assessDefinitionSurfaceContracts(cwd, [provider, pipeline], [semanticContract()], parserWithImports({
        [provider]: ["./semanticRelationPipeline"],
        [pipeline]: [],
      }));
      expect(findings).toEqual([]);
    });
  });

  // D4 回归：注释掉 / 写在字符串里的 import 不是接入——它们不产生 import 语法事实。
  it("does not accept a commented-out or stringified import as contract compliance", async () => {
    await withTemporaryDirectory("definition-surface-contract-commented-import", (cwd) => {
      const commented = join(cwd, "CommentedSemanticRelationProvider.ts");
      const stringified = join(cwd, "StringifiedSemanticRelationProvider.ts");
      const pipeline = join(cwd, "semanticRelationPipeline.ts");
      writeFileSync(commented, '// import { x } from "./semanticRelationPipeline"\nexport const collect = async () => [];\n', "utf8");
      writeFileSync(stringified, 'export const collect = async () => \'from "./semanticRelationPipeline"\';\n', "utf8");
      writeFileSync(pipeline, "export const runLspResolutionPipeline = async () => {};\n", "utf8");
      const findings = assessDefinitionSurfaceContracts(cwd, [commented, stringified, pipeline], [semanticContract()], parserWithImports({
        [commented]: [],
        [stringified]: [],
        [pipeline]: [],
      }));
      expect(findings.map((finding) => finding.file)).toEqual([
        "CommentedSemanticRelationProvider.ts",
        "StringifiedSemanticRelationProvider.ts",
      ]);
    });
  });

  // 同一批事实走真实解析器：注释里的 import 在真实 AST 里同样不产生 imports。
  it("reads contract imports from the real parser AST, not from file text", async () => {
    await withTemporaryDirectory("definition-surface-contract-real-parser", async (cwd) => {
      const provider = join(cwd, "RealSemanticRelationProvider.ts");
      const pipeline = join(cwd, "semanticRelationPipeline.ts");
      writeFileSync(provider, '// import { x } from "./semanticRelationPipeline"\nconst msg = \'from "./semanticRelationPipeline"\';\nexport const collect = async () => [msg];\n', "utf8");
      writeFileSync(pipeline, "export const runLspResolutionPipeline = async () => {};\n", "utf8");
      const findings = await Effect.runPromise(Effect.gen(function* () {
        const used = yield* ParserService;
        return assessDefinitionSurfaceContracts(cwd, [provider, pipeline], [semanticContract()], used);
      }).pipe(Effect.provide(TreeSitterParserLive)));
      expect(findings.map((finding) => finding.file)).toEqual(["RealSemanticRelationProvider.ts"]);
    });
  });

  // 无法解析 = 无法判定：fail-closed 产出 finding，而不是静默当作已接入。
  it("fails closed when a role file cannot be parsed", async () => {
    await withTemporaryDirectory("definition-surface-contract-unparsable", (cwd) => {
      const provider = join(cwd, "BrokenSemanticRelationProvider.ts");
      const pipeline = join(cwd, "semanticRelationPipeline.ts");
      writeFileSync(provider, "export const collect = async () => [];\n", "utf8");
      writeFileSync(pipeline, "export const runLspResolutionPipeline = async () => {};\n", "utf8");
      const findings = assessDefinitionSurfaceContracts(cwd, [provider, pipeline], [semanticContract()], parserWithImports({ [pipeline]: [] }));
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ file: "BrokenSemanticRelationProvider.ts" });
      expect(findings[0]!.message).toContain("无法判定");
    });
  });

  // 读盘失败（文件不存在）同样是"无法判定"，不能抛出去中断整轮契约评估。
  it("fails closed instead of throwing when a role file cannot be read", async () => {
    await withTemporaryDirectory("definition-surface-contract-missing-file", async (cwd) => {
      const missing = join(cwd, "GhostSemanticRelationProvider.ts");
      const pipeline = join(cwd, "semanticRelationPipeline.ts");
      writeFileSync(pipeline, "export const runLspResolutionPipeline = async () => {};\n", "utf8");
      const findings = await Effect.runPromise(Effect.gen(function* () {
        const used = yield* ParserService;
        return assessDefinitionSurfaceContracts(cwd, [missing, pipeline], [semanticContract()], used);
      }).pipe(Effect.provide(TreeSitterParserLive)));
      expect(findings.map((finding) => finding.file)).toEqual(["GhostSemanticRelationProvider.ts"]);
      expect(findings[0]!.message).toContain("无法判定");
    });
  });

  // 角色 glob 覆盖到没有语法支持的文件（例如 Markdown）时，既不能报"已接入"，
  // 也不能凭空报"绕过契约"——保持与旧实现一致的跳过行为。
  it("skips role files whose extension has no parser strategy", async () => {
    await withTemporaryDirectory("definition-surface-contract-unsupported", async (cwd) => {
      const notes = join(cwd, "NotesSemanticRelationProvider.md");
      const pipeline = join(cwd, "semanticRelationPipeline.ts");
      writeFileSync(notes, "# notes\n", "utf8");
      writeFileSync(pipeline, "export const runLspResolutionPipeline = async () => {};\n", "utf8");
      const findings = await Effect.runPromise(Effect.gen(function* () {
        const used = yield* ParserService;
        return assessDefinitionSurfaceContracts(cwd, [notes, pipeline], [semanticContract()], used);
      }).pipe(Effect.provide(TreeSitterParserLive)));
      expect(findings).toEqual([]);
    });
  });
});
