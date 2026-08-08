// Pyright symbol-use calibration (env-gated: OPENARCH_PYRIGHT_INTEGRATION=1 + a
// spawnable pyright executable in OPENARCH_PYRIGHT_PATH).
//
// Windows note: npm's pyright-langserver is a shell shim that Node cannot
// spawn directly (ENOENT). Configure OPENARCH_PYRIGHT_PATH to a real entry
// point (e.g. a .cmd wrapper that runs `node langserver.index.js --stdio`)
// or run on a platform where pyright ships a native executable.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { collectPythonSymbolUse } from "../../src/adapter/symbol-use/PythonSymbolUseProvider";
import { ParserService } from "../../src/port/ParserService";

const roots: string[] = [];
const pyright = process.env.OPENARCH_PYRIGHT_PATH;
const enabled = process.env.OPENARCH_PYRIGHT_INTEGRATION === "1" && Boolean(pyright);

const project = (name: string): string => {
  const cwd = mkdtempSync(join(tmpdir(), `openarch-pyright-${name}-`));
  roots.push(cwd);
  writeFileSync(join(cwd, "pyproject.toml"), "[project]\nname = 'symbol-use'\nversion = '0.0.0'\n");
  return cwd;
};

const write = (cwd: string, path: string, source: string): void => {
  mkdirSync(join(cwd, path, ".."), { recursive: true });
  writeFileSync(join(cwd, path), source);
};

const collect = (cwd: string) => Effect.runPromise(Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* collectPythonSymbolUse({ cwd, languages: ["python"] }, { parser, executable: pyright! });
}).pipe(Effect.provide(TreeSitterParserLive)));

afterEach(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe("Pyright symbol-use calibration", () => {
  it.skipIf(!enabled)("resolves ordinary and single-root namespace package imports", async () => {
    const cwd = project("packages");
    write(cwd, "pkg/__init__.py", "");
    write(cwd, "pkg/producer.py", "def _package_value():\n    return 1\n");
    write(cwd, "space/feature/producer.py", "def _namespace_value():\n    return 1\n");
    write(cwd, "consumer.py", [
      "from pkg.producer import _package_value as package_value",
      "from space.feature.producer import _namespace_value as namespace_value",
      "package_value()",
      "namespace_value()",
    ].join("\n"));

    const report = await collect(cwd);

    expect(report.state).toMatchObject({
      availability: "available",
      coverage: { declarations: "complete", repositoryReferences: "complete" },
    });
    expect(report.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ declaration: expect.objectContaining({ file: "pkg/producer.py", name: "_package_value" }) }),
      expect.objectContaining({ declaration: expect.objectContaining({ file: "space/feature/producer.py", name: "_namespace_value" }) }),
    ]));
  }, 45_000);

  it.skipIf(!enabled)("keeps abstract-method dispatch partial even when an implementation is directly referenced", async () => {
    const cwd = project("abstract");
    write(cwd, "base.py", "import abc\n\nclass _Base(abc.ABC):\n    @abc.abstractmethod\n    def _run(self): ...\n");
    write(cwd, "impl.py", "from base import _Base\n\nclass _Impl(_Base):\n    def _run(self):\n        return 1\n");
    write(cwd, "consumer.py", "from impl import _Impl\n_Impl()._run()\n");

    const report = await collect(cwd);

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      reason: expect.stringContaining("abstract-method dispatch"),
    });
    expect(report.facts).toContainEqual(expect.objectContaining({
      declaration: expect.objectContaining({ file: "base.py", name: "_run" }),
      repositoryReferences: [],
    }));
  }, 45_000);

  it.skipIf(!enabled)("keeps configured workspaces and sys.path mutation partial while retaining facts", async () => {
    const cwd = project("dynamic-workspace");
    writeFileSync(join(cwd, "pyrightconfig.json"), JSON.stringify({ executionEnvironments: [{ root: "." }] }));
    write(cwd, "producer.py", "def _value():\n    return 1\n");
    write(cwd, "consumer.py", "import sys\nfrom producer import _value\nsys.path.append('plugins')\n_value()\n");

    const report = await collect(cwd);

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      reason: expect.stringContaining("execution-environment"),
    });
    expect(report.reason).toContain("runtime import-path mutation");
    const fact = report.facts.find((entry) => entry.declaration.file === "producer.py" && entry.declaration.name === "_value");
    expect(fact).toMatchObject({ declaration: { file: "producer.py", name: "_value" } });
    expect(fact?.repositoryReferences).toEqual(expect.arrayContaining([expect.objectContaining({ file: "consumer.py", line: 2 })]));
  }, 45_000);

  it.skipIf(!enabled)("keeps pyproject tool.pyright resolution configuration partial while retaining references", async () => {
    const cwd = project("pyproject-workspace");
    writeFileSync(join(cwd, "pyproject.toml"), "[tool.pyright]\nexecutionEnvironments = [{ root = \".\" }]\n");
    write(cwd, "producer.py", "def _value():\n    return 1\n");
    write(cwd, "consumer.py", "from producer import _value\n_value()\n");

    const report = await collect(cwd);

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "complete", repositoryReferences: "partial" },
      reason: expect.stringContaining("execution-environment"),
    });
    const fact = report.facts.find((entry) => entry.declaration.file === "producer.py" && entry.declaration.name === "_value");
    expect(fact?.repositoryReferences).toEqual(expect.arrayContaining([expect.objectContaining({ file: "consumer.py", line: 1 })]));
  }, 45_000);

  it.skipIf(!enabled)("keeps multi-root namespace package references partial while retaining the cross-root use", async () => {
    const cwd = project("multi-root-namespace");
    writeFileSync(join(cwd, "pyrightconfig.json"), JSON.stringify({ extraPaths: ["namespace-a", "namespace-b"] }));
    write(cwd, "namespace-a/acme/producer.py", "def _value():\n    return 1\n");
    write(cwd, "namespace-b/acme/consumer.py", "from acme.producer import _value\n_value()\n");

    const report = await collect(cwd);

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "complete", repositoryReferences: "partial" },
      reason: expect.stringContaining("execution-environment"),
    });
    const fact = report.facts.find((entry) => entry.declaration.file === "namespace-a/acme/producer.py" && entry.declaration.name === "_value");
    expect(fact?.repositoryReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "namespace-b/acme/consumer.py", line: 1 }),
    ]));
  }, 45_000);

  it.skipIf(!enabled)("keeps meta-path import hooks partial while retaining static references", async () => {
    const cwd = project("import-hook");
    write(cwd, "producer.py", "def _value():\n    return 1\n");
    write(cwd, "consumer.py", [
      "import sys",
      "from producer import _value",
      "sys.meta_path.append(object())",
      "_value()",
    ].join("\n"));

    const report = await collect(cwd);

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      reason: expect.stringContaining("runtime import-path mutation"),
    });
    const fact = report.facts.find((entry) => entry.declaration.file === "producer.py" && entry.declaration.name === "_value");
    expect(fact?.repositoryReferences).toEqual(expect.arrayContaining([expect.objectContaining({ file: "consumer.py", line: 2 })]));
  }, 45_000);
});
