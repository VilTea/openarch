import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { collectGoSymbolUse } from "../../src/adapter/symbol-use/GoSymbolUseProvider";
import { ParserService } from "../../src/port/ParserService";
import { collectStaticImportConsumers } from "./support/staticImportConsumers";

const roots: string[] = [];
const gopls = process.env.OPENARCH_GOPLS_PATH;
const go = process.env.OPENARCH_GO_PATH;
const serviceCwd = process.env.OPENARCH_GOPLS_SERVICE_CWD;
const calibrationCwd = process.env.OPENARCH_GOPLS_CALIBRATION_CWD;
const pruningCwd = process.env.OPENARCH_GOPLS_PRUNING_CALIBRATION_CWD;
const enabled = process.env.OPENARCH_GOPLS_INTEGRATION === "1" && Boolean(gopls && go);

const project = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "openarch-gopls-symbol-use-"));
  roots.push(cwd);
  writeFileSync(join(cwd, "go.mod"), "module example.com/symboluse\n\ngo 1.26\n");
  writeFileSync(join(cwd, "producer.go"), "package symboluse\n\nfunc hidden() string { return \"ok\" }\n");
  writeFileSync(join(cwd, "consumer.go"), "package symboluse\n\nfunc use() string { return hidden() }\n");
  return cwd;
};

const collect = (cwd: string, demand?: { readonly declarations: readonly { readonly file: string; readonly names: readonly string[] }[] }) => Effect.runPromise(Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* collectGoSymbolUse({ cwd, languages: ["go"], ...(demand ? { demand } : {}) }, {
    parser,
    executable: gopls!,
    environment: {
      ...process.env,
      PATH: [dirname(go!), process.env.PATH].filter(Boolean).join(delimiter),
    },
  });
}).pipe(Effect.provide(TreeSitterParserLive)));

afterEach(async () => {
  // gopls may release its workspace handles just after the LSP exit notification on Windows.
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe("gopls symbol-use calibration", () => {
  it.skipIf(!enabled)("resolves a private function across a calibrated single-module workspace", async () => {
    const cwd = project();
    const report = await collect(cwd);

    expect(report.state).toMatchObject({
      availability: "available",
      coverage: { declarations: "complete", repositoryReferences: "complete" },
    });
    expect(report.facts).toContainEqual(expect.objectContaining({
      declaration: expect.objectContaining({ file: "producer.go", name: "hidden" }),
      repositoryReferences: [expect.objectContaining({ file: "consumer.go", line: 3 })],
    }));
    expect(report.state.coverage.incompleteReferences).toBe(false);
  }, 45_000);

  it.skipIf(!enabled || !serviceCwd)("resolves a private cross-file call in an explicit real Go service", async () => {
    const report = await collect(serviceCwd!);

    expect(report.state).toMatchObject({
      availability: "available",
      coverage: { declarations: "complete", repositoryReferences: "complete" },
    });
    const fact = report.facts.find((entry) => entry.declaration.file === "internal/evidence/adapter/docsrepo/git.go" && entry.declaration.name === "newGitClient");
    expect(fact?.repositoryReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "internal/evidence/adapter/docsrepo/authority.go" }),
    ]));
  }, 60_000);

  it.skipIf(!enabled || !calibrationCwd)("keeps an external build-constrained module partial without discarding facts", async () => {
    const report = await collect(calibrationCwd!);

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      reason: expect.stringContaining("build constraints"),
    });
    expect(report.facts.length).toBeGreaterThan(0);
  }, 120_000);

  it.skipIf(!enabled || !calibrationCwd)("retains a demanded external Go declaration and its direct references", async () => {
    const report = await collect(calibrationCwd!, {
      declarations: [{ file: "uuid.go", names: ["Parse"] }],
    });

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      facts: [expect.objectContaining({
        declaration: expect.objectContaining({ file: "uuid.go", name: "Parse" }),
        repositoryReferences: expect.arrayContaining([expect.objectContaining({ file: "sql.go" })]),
      })],
      reason: expect.stringContaining("demand-driven semantic query selected 1/"),
    });
    const staticScope = await Effect.runPromise(collectStaticImportConsumers(calibrationCwd!, "go", "uuid.go").pipe(Effect.provide(TreeSitterParserLive)));
    const parse = report.facts.find((fact) => fact.declaration.file === "uuid.go" && fact.declaration.name === "Parse");
    const productionSymbolConsumers = parse?.repositoryReferences.map((reference) => reference.file).filter((file) => staticScope.sourceFiles.includes(file));
    expect(staticScope.consumers).toEqual([]);
    expect(productionSymbolConsumers).toContain("sql.go");
  }, 45_000);

  it.skipIf(!enabled || !pruningCwd)("keeps a large external module partial under a bounded changed-declaration query", async () => {
    const report = await collect(pruningCwd!, {
      declarations: [{ file: "prometheus/counter.go", names: ["NewCounter"] }],
    });

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      reason: expect.stringContaining("demand-driven semantic query selected 1/"),
    });
  }, 45_000);

  it.skipIf(!enabled)("keeps go.work workspaces partial while retaining cross-file references", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "go.work"), "go 1.26\n\nuse .\n");

    const report = await collect(cwd);

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "complete", repositoryReferences: "partial" },
      reason: expect.stringContaining("workspace mode"),
    });
    expect(report.facts).toContainEqual(expect.objectContaining({
      declaration: expect.objectContaining({ file: "producer.go", name: "hidden" }),
      repositoryReferences: expect.arrayContaining([expect.objectContaining({ file: "consumer.go", line: 3 })]),
    }));
  }, 60_000);

  it.skipIf(!enabled)("keeps generated Go source partial while retaining cross-file references", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "producer.go"), "// Code generated by symbol-use fixture. DO NOT EDIT.\n\npackage symboluse\n\nfunc hidden() string { return \"ok\" }\n");

    const report = await collect(cwd);

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      reason: expect.stringContaining("generated Go source"),
    });
    expect(report.facts).toContainEqual(expect.objectContaining({
      declaration: expect.objectContaining({ file: "producer.go", name: "hidden" }),
      repositoryReferences: expect.arrayContaining([expect.objectContaining({ file: "consumer.go", line: 3 })]),
    }));
  }, 60_000);

  it.skipIf(!enabled)("keeps build-constrained source partial while retaining cross-file references", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "producer.go"), "//go:build windows || !windows\n\npackage symboluse\n\nfunc hidden() string { return \"ok\" }\n");

    const report = await collect(cwd);

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      reason: expect.stringContaining("build constraints"),
    });
    expect(report.facts).toContainEqual(expect.objectContaining({
      declaration: expect.objectContaining({ file: "producer.go", name: "hidden" }),
      repositoryReferences: expect.arrayContaining([expect.objectContaining({ file: "consumer.go", line: 3 })]),
    }));
  }, 60_000);
});
