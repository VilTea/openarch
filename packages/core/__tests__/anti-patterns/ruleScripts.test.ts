import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { createProjectFacts, selectScriptTargetFiles } from "../../src/script-runtime/projectFacts";

const rule = async (name: string) => (await import(pathToFileURL(`${process.cwd()}/../../.openarch/anti-patterns/rules/${name}.mjs`).href)).default;
const templateRule = async (name: string) => {
  const language = name.startsWith("python-") ? "python"
    : name.startsWith("go-") ? "go"
      : name.startsWith("rust-") ? "rust"
        : name.startsWith("typescript-") ? "typescript"
          : name.startsWith("java-") ? "java"
        : "common";
  const file = language === "common" ? name : name.replace(/^(python|go|rust|typescript|java)-/, "");
  return (await import(pathToFileURL(`${process.cwd()}/assets/templates/${language}/anti-patterns/${file}.mjs`).href)).default;
};
const facts = (authorities: readonly Record<string, unknown>[], files: readonly string[] = []) => createProjectFacts({ files, authorities: authorities as never });

describe("built-in anti-pattern rules", () => {
  it("limits runtime discovery audits to implementation paths, not release or lint tooling", async () => {
    const [hardcodedShape, authorityBypass, parallelLanguageFacts] = await Promise.all([
      rule("hardcoded-project-shape"), rule("authority-bypass"), rule("parallel-language-facts"),
    ]);
    const files = [
      "packages/core/src/application/discover.ts", "packages/cli/bin/openarch.js",
      "scripts/package-binary.mjs", "scripts/package-local.mjs", "eslint.config.mjs",
    ];
    const projectFacts = createProjectFacts({ files });
    for (const script of [hardcodedShape, authorityBypass, parallelLanguageFacts]) {
      expect(selectScriptTargetFiles(files, script.targets, projectFacts).files).toEqual([
        "packages/core/src/application/discover.ts", "packages/cli/bin/openarch.js",
      ]);
    }
  });

  it("reports empty function bodies but not non-empty implementations", async () => {
    const ruleModule = await rule("no-empty-function");
    const empty = await ruleModule.link({ records: [{ _file: "a.ts", body: "{}" }] });
    const full = await ruleModule.link({ records: [{ _file: "a.ts", body: "{ return 1; }" }] });
    expect(empty).toHaveLength(1);
    expect(full).toHaveLength(0);
  });

  it("reports async functions without await", async () => {
    const ruleModule = await rule("async-without-await");
    const fake = await ruleModule.link({ records: [{ _file: "a.ts", fn: "async function load() { return 1; }" }] });
    const real = await ruleModule.link({ records: [{ _file: "a.ts", fn: "async function load() { await fetch('/api'); }" }] });
    expect(fake).toHaveLength(1);
    expect(real).toHaveLength(0);
  });

  it("reports interpolated shell command strings but not argument-vector execution", async () => {
    const ruleModule = await rule("no-interpolated-shell-command");
    const unsafe = ruleModule.link({ records: [{
      _file: "packages/core/src/docs-repo/DocsRepoManager.ts",
      callee: "execSync",
      command: '`git clone "${url}" "${target}"`',
    }] });
    const safe = ruleModule.link({ records: [{
      _file: "packages/core/src/docs-repo/DocsRepoManager.ts",
      callee: "execFileSync",
      command: "`git clone --depth=1`",
    }] });

    expect(unsafe).toEqual([expect.objectContaining({ ruleId: "no-interpolated-shell-command" })]);
    expect(safe).toEqual([]);
  });

  it("keeps placeholder implementation as one family with language-specific templates", async () => {
    const [typescript, python, go, rust, java] = await Promise.all([
      templateRule("typescript-no-empty-function"),
      templateRule("python-placeholder-implementation"),
      templateRule("go-placeholder-implementation"),
      templateRule("rust-placeholder-implementation"),
      templateRule("java-placeholder-implementation"),
    ]);

    expect(await typescript.link({ records: [{ _file: "service.ts", body: "{}" }] })).toEqual([
      expect.objectContaining({ ruleId: "no-empty-function", category: "quality", patternFamily: "placeholder-implementation" }),
    ]);
    expect(await python.link({ records: [{ _file: "service.py", body: "pass" }] })).toEqual([
      expect.objectContaining({ ruleId: "placeholder-implementation" }),
    ]);
    expect(await python.link({ records: [{ _file: "service.py", body: "return value" }] })).toEqual([]);
    expect(await go.link({ records: [{ _file: "service.go", body: "{}" }] })).toEqual([
      expect.objectContaining({ ruleId: "placeholder-implementation" }),
    ]);
    expect(await rust.link({ records: [{ _file: "service.rs", body: "{ }" }] })).toEqual([
      expect.objectContaining({ ruleId: "placeholder-implementation", category: "quality", patternFamily: "placeholder-implementation" }),
    ]);
    expect(await java.link({ records: [{ _file: "Service.java", body: "{}" }] })).toEqual([
      expect.objectContaining({ ruleId: "placeholder-implementation", category: "quality", patternFamily: "placeholder-implementation" }),
    ]);
  });

  it("keeps silent error handling as a separate family with language-specific templates", async () => {
    const [typescript, python, java] = await Promise.all([
      templateRule("typescript-no-empty-catch"),
      templateRule("python-silent-error-handling"),
      templateRule("java-silent-error-handling"),
    ]);

    expect(await typescript.link({ records: [{ _file: "service.ts", body: "{}" }] })).toEqual([
      expect.objectContaining({ ruleId: "no-empty-catch", category: "correctness", patternFamily: "silent-error-handling" }),
    ]);
    expect(await python.link({ records: [{ _file: "service.py", body: "pass" }] })).toEqual([
      expect.objectContaining({ ruleId: "silent-error-handling", category: "correctness", patternFamily: "silent-error-handling" }),
    ]);
    expect(await java.link({ records: [{ _file: "Service.java", body: "{}" }] })).toEqual([
      expect.objectContaining({ ruleId: "silent-error-handling", category: "correctness", patternFamily: "silent-error-handling" }),
    ]);
  });

  it("reports hardcoded repository root globs in generic code", async () => {
    const ruleModule = await rule("hardcoded-project-shape");
    const records = ruleModule.stages.ast.extract([
      { captures: [{ name: "literal", text: '"packages/**/*.ts"', startLine: 12 }] },
      { captures: [{ name: "literal", text: '"src/**/*.ts"', startLine: 13 }] },
    ], "packages/core/src/application/discover.ts");
    const hits = await ruleModule.link({ records });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ruleId: "hardcoded-project-shape", file: "packages/core/src/application/discover.ts" });
  });

  it("accepts an explicitly classified persisted version boundary and reports an unclassified one", async () => {
    const ruleModule = await rule("version-boundary-audit");
    const classified = await ruleModule.link({ records: [
      { _file: "src/domain/calibration.ts", value: "structural-calibration-v1", line: 5 },
      { _file: "src/domain/calibration.ts", value: "persisted", line: 6 },
      { _file: "src/domain/calibration.ts", value: "baseline-index", line: 7 },
      { _file: "src/domain/calibration.ts", value: "reject", line: 8 },
      { _file: "src/domain/calibration.ts", value: "legacy-supported", line: 9 },
    ] });
    const unclassified = await ruleModule.link({ records: [
      { _file: "src/domain/report.ts", value: "report-contract-v1", line: 12 },
    ] });
    expect(classified).toEqual([]);
    expect(unclassified).toEqual([expect.objectContaining({ ruleId: "version-boundary-audit", file: "src/domain/report.ts" })]);
  });

  it("does not report generic extension globs as hardcoded project shape", async () => {
    const ruleModule = await rule("hardcoded-project-shape");
    const records = ruleModule.stages.ast.extract([
      { captures: [{ name: "literal", text: '"**/*.ts"', startLine: 12 }] },
      { captures: [{ name: "literal", text: '"src/**/*.ts"', startLine: 13 }] },
    ], "packages/core/src/application/discover.ts");
    const hits = await ruleModule.link({ records });
    expect(hits).toHaveLength(0);
  });

  it("reports parallel language facts outside the registration authority", async () => {
    const ruleModule = await rule("parallel-language-facts");
    const records = ruleModule.stages.ast.extract([
      { captures: [
        { name: "literal", text: '"typescript"', startLine: 5 },
        { name: "literal", text: '".ts"', startLine: 6 },
        { name: "literal", text: '".tsx"', startLine: 6 },
        { name: "literal", text: '"javascript"', startLine: 7 },
        { name: "literal", text: '".js"', startLine: 8 },
        { name: "literal", text: '".jsx"', startLine: 8 },
      ] },
    ], "packages/cli/src/runtime.ts");
    const hits = await ruleModule.link({ records });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ruleId: "parallel-language-facts", file: "packages/cli/src/runtime.ts" });
  });

  it("reports AST-source regex parsing in a parser strategy but allows node-field extraction", async () => {
    const ruleModule = await rule("no-regex-parser-source");
    const dirty = ruleModule.stages.ast.extract([{ captures: [{
      name: "node", text: "const text = node.text;", startLine: 12,
    }] }], "packages/core/src/adapter/parser/ExampleStrategy.ts");
    const clean = ruleModule.stages.ast.extract([{ captures: [{
      name: "node", text: "const name = node.childForFieldName?.('name')?.text;", startLine: 13,
    }] }], "packages/core/src/adapter/parser/ExampleStrategy.ts");
    expect(await ruleModule.link({ records: dirty })).toEqual([
      expect.objectContaining({ ruleId: "no-regex-parser-source", file: "packages/core/src/adapter/parser/ExampleStrategy.ts" }),
    ]);
    expect(await ruleModule.link({ records: clean })).toEqual([]);
  });

  it("reports direct baseline shard reads but allows the StorageService entry point", async () => {
    const ruleModule = await rule("no-direct-baseline-storage");
    expect(ruleModule.authority).toMatchObject({
      id: "baseline-storage-access",
      owner: "packages/core/src/port/StorageService.ts",
    });
    const authorities = [ruleModule.authority];
    const factsFor = (files) => facts(authorities, files);
    const files = [
      "packages/core/src/application/governance/gateApp.ts",
      "packages/core/src/application/governance/review.ts",
    ];
    const candidates = ruleModule.stages.text({
      files,
      text: (file) => file.endsWith("gateApp.ts")
        ? 'import { readFileSync } from "node:fs";\nimport { baselineDir } from "../../infra/paths";'
        : 'import { StorageService } from "../../port/StorageService";',
      facts: factsFor(files),
    });
    const records = ruleModule.stages.ast.extract([
      { captures: [{ name: "import", text: 'import { readFileSync } from "node:fs";' }] },
      { captures: [{ name: "import", text: 'import { baselineDir } from "../../infra/paths";' }] },
    ], files[0]);
    expect(candidates).toEqual([files[0]]);
    expect(ruleModule.link({ records, facts: factsFor(files) })).toEqual([
      expect.objectContaining({ ruleId: "no-direct-baseline-storage", file: files[0] }),
    ]);
  });

  it("reports a complete FileKind shadow definition but ignores ordinary role comparisons", async () => {
    const ruleModule = await rule("no-file-kind-shadow-definition");
    const duplicate = ruleModule.stages.ast.extract([{ captures: [
      { name: "literal", text: '"production"', startLine: 5 },
      { name: "literal", text: '"test"', startLine: 5 },
      { name: "literal", text: '"generated"', startLine: 5 },
      { name: "literal", text: '"auxiliary"', startLine: 5 },
    ] }], "packages/core/src/application/legacyFileKinds.ts");
    const ordinary = ruleModule.stages.ast.extract([{ captures: [
      { name: "literal", text: '"production"', startLine: 12 },
    ] }], "packages/core/src/application/scan.ts");

    expect(ruleModule.link({ records: duplicate })).toEqual([
      expect.objectContaining({ ruleId: "file-kind-shadow-definition", file: "packages/core/src/application/legacyFileKinds.ts" }),
    ]);
    expect(ruleModule.link({ records: ordinary })).toEqual([]);
  });

  it("ignores partial language facts and authority owner definitions", async () => {
    const ruleModule = await rule("parallel-language-facts");
    const partial = ruleModule.stages.ast.extract([
      { captures: [
        { name: "literal", text: '"typescript"', startLine: 5 },
        { name: "literal", text: '".ts"', startLine: 6 },
      ] },
    ], "packages/cli/src/runtime.ts");
    const owner = ruleModule.stages.ast.extract([
      { captures: [
        { name: "literal", text: '"typescript"', startLine: 5 },
        { name: "literal", text: '".ts"', startLine: 6 },
        { name: "literal", text: '".tsx"', startLine: 6 },
        { name: "literal", text: '"javascript"', startLine: 7 },
        { name: "literal", text: '".js"', startLine: 8 },
        { name: "literal", text: '".jsx"', startLine: 8 },
      ] },
    ], "packages/core/src/adapter/parser/LanguageRegistry.ts");
    expect(ruleModule.link({ records: partial })).toHaveLength(0);
    expect(ruleModule.link({ records: owner })).toHaveLength(0);
  });

  it("reports authority bypass when a file reimplements discovery without authority imports", async () => {
    const ruleModule = await rule("authority-bypass");
    const records = ruleModule.stages.ast.extract([
      { captures: [
        { name: "literal", text: '"packages/**/*.ts"', startLine: 9 },
        { name: "literal", text: '"typescript"', startLine: 10 },
        { name: "literal", text: '".ts"', startLine: 11 },
        { name: "literal", text: '".tsx"', startLine: 11 },
        { name: "literal", text: '"javascript"', startLine: 12 },
        { name: "literal", text: '".js"', startLine: 13 },
        { name: "literal", text: '".jsx"', startLine: 13 },
      ] },
    ], "packages/core/src/application/discover.ts");
    const hits = await ruleModule.link({ records });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ruleId: "authority-bypass", file: "packages/core/src/application/discover.ts" });
  });

  it("ignores files that already import authority entrypoints or only contain incomplete language facts", async () => {
    const ruleModule = await rule("authority-bypass");
    const withAuthorityImport = ruleModule.stages.ast.extract([
      { captures: [
        { name: "literal", text: '"../adapter/parser/LanguageRegistry"', startLine: 3 },
        { name: "literal", text: '"typescript"', startLine: 5 },
        { name: "literal", text: '".ts"', startLine: 6 },
        { name: "literal", text: '".tsx"', startLine: 6 },
        { name: "literal", text: '"javascript"', startLine: 7 },
        { name: "literal", text: '".js"', startLine: 8 },
        { name: "literal", text: '".jsx"', startLine: 8 },
      ] },
    ], "packages/cli/src/runtime.ts");
    const incompleteLanguageFacts = ruleModule.stages.ast.extract([
      { captures: [
        { name: "literal", text: '"typescript"', startLine: 5 },
        { name: "literal", text: '".ts"', startLine: 6 },
      ] },
    ], "packages/core/src/application/discover.ts");
    expect(ruleModule.link({ records: withAuthorityImport })).toHaveLength(0);
    expect(ruleModule.link({ records: incompleteLanguageFacts })).toHaveLength(0);
  });

  it("reports only newly added prohibited imports inside an explicit authority boundary", async () => {
    const ruleModule = await templateRule("authority-boundary");
    const authorities = [{
      id: "module-resolution",
      owner: "src/architecture/module-resolver.ts",
      publicEntry: "src/architecture/module-resolver.ts",
      protectedPaths: ["src/syntax/"],
      prohibitedImports: ["node:fs"],
    }];
    const added = await ruleModule.detect({
      facts: facts(authorities),
      changeSet: { availability: "available", files: [{
        path: "src/syntax/types.ts", kind: "modified", authorityIds: ["module-resolution"], beforeText: 'import { parse } from "tree-sitter";',
        afterText: 'import { readFileSync } from "node:fs";\nimport { parse } from "tree-sitter";',
        beforeStaticImports: ["tree-sitter"], afterStaticImports: ["node:fs", "tree-sitter"],
      }] },
    });
    const unchanged = await ruleModule.detect({
      facts: facts(authorities),
      changeSet: { availability: "available", files: [{
        path: "src/syntax/types.ts", kind: "modified", authorityIds: ["module-resolution"], beforeText: 'import { readFileSync } from "node:fs";',
        afterText: 'import { readFileSync } from "node:fs";\nexport const parse = true;',
        beforeStaticImports: ["node:fs"], afterStaticImports: ["node:fs"],
      }] },
    });
    const outsideBoundary = await ruleModule.detect({
      facts: facts(authorities),
      changeSet: { availability: "available", files: [{
        path: "src/other/types.ts", kind: "modified", authorityIds: [], beforeText: "",
        afterText: 'import { readFileSync } from "node:fs";', beforeStaticImports: [], afterStaticImports: ["node:fs"],
      }] },
    });
    expect(added).toEqual([expect.objectContaining({ ruleId: "authority-boundary-bypass", file: "src/syntax/types.ts" })]);
    expect(unchanged).toEqual([]);
    expect(outsideBoundary).toEqual([]);
  });

  it("uses declared relative imports to prune and report a role boundary", async () => {
    const ruleModule = await templateRule("authority-import-bypass");
    const authorities = [{
      id: "test-execution",
      owner: "src/application/tests.ts",
      publicEntry: "src/application/tests.ts",
      protectedPaths: ["src/testing/runners/"],
      prohibitedImports: ["../../port/ParserService"],
    }];
    const candidates = ruleModule.stages.text({
      files: ["src/testing/runners/cargo.ts", "src/testing/providers/rust.ts"],
      text: (file: string) => file.endsWith("cargo.ts")
        ? 'import type { ParserService } from "../../port/ParserService";'
        : 'import { test } from "vitest";',
      facts: facts(authorities, ["src/testing/runners/cargo.ts", "src/testing/providers/rust.ts"]),
    });
    const hits = ruleModule.link({
      facts: facts(authorities, ["src/testing/runners/cargo.ts", "src/testing/providers/rust.ts"]),
      records: [{ _file: "src/testing/runners/cargo.ts", source: "../../port/ParserService", line: 1 }],
    });
    expect(candidates).toEqual(["src/testing/runners/cargo.ts"]);
    expect(hits).toEqual([expect.objectContaining({
      ruleId: "authority-import-bypass", evidence: expect.stringContaining("test-execution"),
    })]);
  });

  it("reports an inline script body inside its script-local starter registry boundary", async () => {
    const ruleModule = await rule("no-inline-script-starters");
    expect(ruleModule.authority).toMatchObject({
      id: "script-starter-assets",
      owner: "packages/openarch-templates/default-scripts.json",
      protectedPaths: ["packages/core/src/script-runtime/scriptStarters.ts"],
    });
    const authorities = [ruleModule.authority];
    const candidates = ruleModule.stages.text({
      files: ["packages/core/src/script-runtime/scriptStarters.ts", "packages/core/src/script-runtime/projectFacts.ts"],
      text: (file) => file.endsWith("scriptStarters.ts") ? "source: `export default {};`" : "export const facts = {};",
      facts: facts(authorities),
    });
    const hits = ruleModule.link({ records: candidates.map((_file) => ({ _file })) });
    expect(candidates).toEqual(["packages/core/src/script-runtime/scriptStarters.ts"]);
    expect(hits).toEqual([expect.objectContaining({ ruleId: "no-inline-script-starters" })]);
  });

  it("blocks legacy capability paths only inside its script-local DocumentStore boundary", async () => {
    const ruleModule = await rule("no-legacy-document-capability-path");
    expect(ruleModule.authority).toMatchObject({
      id: "document-capability-location",
      owner: "packages/core/src/document-store/DocumentStore.ts",
      publicEntry: "packages/core/src/document-store/DocumentStore.ts#capabilityAssetPath",
    });
    const authorities = [ruleModule.authority];
    const candidates = ruleModule.stages.text({
      files: ["packages/core/src/application/initApp.ts"],
      text: () => 'const path = "projects/" + basename(cwd) + "/CORE-CAPABILITIES.md";',
      facts: facts(authorities, ["packages/core/src/application/initApp.ts"]),
    });
    const hits = ruleModule.link({ records: candidates.map((_file) => ({ _file })), facts: facts(authorities, ["packages/core/src/application/initApp.ts"]) });
    const legalCandidates = ruleModule.stages.text({
      files: ["packages/core/src/application/initApp.ts"],
      text: () => 'const path = capabilityAssetPath(store);',
      facts: facts(authorities, ["packages/core/src/application/initApp.ts"]),
    });

    expect(candidates).toEqual(["packages/core/src/application/initApp.ts"]);
    expect(hits).toEqual([expect.objectContaining({ ruleId: "no-legacy-document-capability-path" })]);
    expect(legalCandidates).toEqual([]);
  });

  it("reports direct repository imports only inside declared authority boundaries", async () => {
    const ruleModule = await templateRule("authority-import-bypass");
    const authorities = [{
      id: "script-runtime",
      owner: "src/runtime/staged.ts",
      publicEntry: "src/runtime/staged.ts",
      protectedPaths: ["src/domains/deps.ts"],
      prohibitedImports: ["node:fs"],
    }];
    const protectedImport = await ruleModule.link({
      records: [{ _file: "src/domains/deps.ts", source: "node:fs", line: 3 }],
      facts: facts(authorities, ["src/domains/deps.ts"]),
    });
    const legalAlternative = await ruleModule.link({
      records: [{ _file: "src/domains/deps.ts", source: "../runtime/staged", line: 3 }],
      facts: facts(authorities, ["src/domains/deps.ts"]),
    });
    const missingAuthority = await ruleModule.link({
      records: [{ _file: "src/domains/deps.ts", source: "node:fs", line: 3 }],
      facts: facts([]),
    });
    expect(protectedImport).toEqual([expect.objectContaining({ ruleId: "authority-import-bypass", file: "src/domains/deps.ts" })]);
    expect(legalAlternative).toEqual([]);
    expect(missingAuthority).toEqual([]);
  });

  it("flags the historical TypeScript strategy resolver bypass", async () => {
    const ruleModule = await templateRule("authority-import-bypass");
    const hits = await ruleModule.link({
      facts: facts([{
        id: "module-resolution",
        owner: "packages/core/src/adapter/parser/TsModuleResolver.ts",
        publicEntry: "packages/core/src/adapter/parser/TsModuleResolver.ts",
        protectedPaths: ["packages/core/src/adapter/parser/TsStrategy.ts"],
        prohibitedImports: ["node:fs", "node:path"],
      }], ["packages/core/src/adapter/parser/TsStrategy.ts"]),
      records: [
        { _file: "packages/core/src/adapter/parser/TsStrategy.ts", source: "node:fs", line: 1 },
        { _file: "packages/core/src/adapter/parser/TsStrategy.ts", source: "node:path", line: 2 },
      ],
    });
    expect(hits).toEqual([
      expect.objectContaining({ ruleId: "authority-import-bypass", evidence: expect.stringContaining("module-resolution") }),
      expect.objectContaining({ ruleId: "authority-import-bypass", evidence: expect.stringContaining("module-resolution") }),
    ]);
  });
});
