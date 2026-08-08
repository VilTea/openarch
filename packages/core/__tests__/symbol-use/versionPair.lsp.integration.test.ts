import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { SymbolUseServiceLive } from "../../src/adapter/symbol-use/SymbolUseServiceLive";
import { SemanticToolchainDiscoveryLive } from "../../src/adapter/toolchain/SemanticToolchainDiscoveryLive";
import { collectLspSymbolVersionPair } from "../../src/application/symbolVersionPair";

const roots: string[] = [];
const pyright = process.env.OPENARCH_PYRIGHT_PATH;
const enabled = process.env.OPENARCH_PYRIGHT_INTEGRATION === "1" && Boolean(pyright);

const git = (cwd: string, args: readonly string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const project = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "openarch-symbol-version-pyright-"));
  roots.push(cwd);
  mkdirSync(join(cwd, ".openarch"), { recursive: true });
  writeFileSync(join(cwd, ".openarch", "config.yml"), "languages: [python]\n");
  writeFileSync(join(cwd, "pyproject.toml"), "[project]\nname = 'version-pair'\nversion = '0.0.0'\n");
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "openarch@example.test"]);
  git(cwd, ["config", "user.name", "OpenArch test"]);
  return cwd;
};

const commit = (cwd: string, message: string): void => {
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", message]);
};

const collect = (cwd: string) => Effect.runPromise(
  collectLspSymbolVersionPair(cwd, "HEAD", "python").pipe(
    Effect.provide(SymbolUseServiceLive),
    Effect.provide(SemanticToolchainDiscoveryLive),
    Effect.provide(TreeSitterParserLive),
  ),
);

afterEach(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe("LSP version-paired symbol facts", () => {
  it.skipIf(!enabled)("collects Pyright facts from isolated Git revision workspaces", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "producer.py"), "def _worker() -> int:\n    return 1\n");
    writeFileSync(join(cwd, "consumer.py"), "from producer import _worker\nvalue = _worker()\n");
    commit(cwd, "before");
    writeFileSync(join(cwd, "producer.py"), "def _worker() -> int:\n    return 2\n");
    commit(cwd, "after");

    const report = await collect(cwd);
    const matched = report.declarations.find((entry) => entry.status === "matched" && entry.after?.declaration.name === "_worker");

    expect(report).toMatchObject({
      availability: "available",
      before: { providerId: "python-pyright-symbol-use", availability: "available" },
      after: { providerId: "python-pyright-symbol-use", availability: "available" },
    });
    expect(matched?.before?.repositoryReferences).toContainEqual(expect.objectContaining({ file: "consumer.py", line: 1 }));
    expect(matched?.after?.repositoryReferences).toContainEqual(expect.objectContaining({ file: "consumer.py", line: 1 }));
  }, 45_000);

  it.skipIf(!enabled)("preserves Pyright partial boundaries across isolated Git revision workspaces", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "pyrightconfig.json"), JSON.stringify({ executionEnvironments: [{ root: "." }] }));
    writeFileSync(join(cwd, "producer.py"), "def _worker() -> int:\n    return 1\n");
    writeFileSync(join(cwd, "consumer.py"), "import sys\nfrom producer import _worker\nsys.path.append('plugins')\nvalue = _worker()\n");
    commit(cwd, "before with dynamic resolution boundary");
    writeFileSync(join(cwd, "producer.py"), "def _worker() -> int:\n    return 2\n");
    commit(cwd, "after with dynamic resolution boundary");

    const report = await collect(cwd);
    const matched = report.declarations.find((entry) => entry.status === "matched" && entry.after?.declaration.name === "_worker");

    expect(report).toMatchObject({
      availability: "partial",
      before: {
        providerId: "python-pyright-symbol-use", availability: "partial",
        coverage: { declarations: "partial", repositoryReferences: "partial" },
      },
      after: {
        providerId: "python-pyright-symbol-use", availability: "partial",
        coverage: { declarations: "partial", repositoryReferences: "partial" },
      },
    });
    expect(report.before?.reason).toContain("execution-environment");
    expect(report.before?.reason).toContain("runtime import-path mutation");
    expect(report.after?.reason).toContain("execution-environment");
    expect(report.after?.reason).toContain("runtime import-path mutation");
    expect(matched?.before?.repositoryReferences).toContainEqual(expect.objectContaining({ file: "consumer.py", line: 2 }));
    expect(matched?.after?.repositoryReferences).toContainEqual(expect.objectContaining({ file: "consumer.py", line: 2 }));
  }, 45_000);
});
