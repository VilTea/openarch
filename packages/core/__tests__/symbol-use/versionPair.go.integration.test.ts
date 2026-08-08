import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { SymbolUseServiceLive } from "../../src/adapter/symbol-use/SymbolUseServiceLive";
import { SemanticToolchainDiscoveryLive } from "../../src/adapter/toolchain/SemanticToolchainDiscoveryLive";
import { collectLspSymbolVersionPair } from "../../src/application/symbolVersionPair";

const roots: string[] = [];
const gopls = process.env.OPENARCH_GOPLS_PATH;
const go = process.env.OPENARCH_GO_PATH;
const enabled = process.env.OPENARCH_GOPLS_INTEGRATION === "1" && Boolean(gopls && go);

const git = (cwd: string, args: readonly string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const project = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "openarch-symbol-version-gopls-"));
  roots.push(cwd);
  mkdirSync(join(cwd, ".openarch"), { recursive: true });
  writeFileSync(join(cwd, ".openarch", "config.yml"), "languages: [go]\n");
  writeFileSync(join(cwd, "go.mod"), "module example.com/versionpair\n\ngo 1.26\n");
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
  collectLspSymbolVersionPair(cwd, "HEAD", "go").pipe(
    Effect.provide(SymbolUseServiceLive),
    Effect.provide(SemanticToolchainDiscoveryLive),
    Effect.provide(TreeSitterParserLive),
  ),
);

afterEach(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe("Go LSP version-paired symbol facts", () => {
  it.skipIf(!enabled)("collects gopls facts from isolated Git revision workspaces", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "producer.go"), "package versionpair\n\nfunc hidden() int { return 1 }\n");
    writeFileSync(join(cwd, "consumer.go"), "package versionpair\n\nfunc use() int { return hidden() }\n");
    commit(cwd, "before");
    writeFileSync(join(cwd, "producer.go"), "package versionpair\n\nfunc hidden() int { return 2 }\n");
    commit(cwd, "after");

    const report = await collect(cwd);
    const matched = report.declarations.find((entry) => entry.status === "matched" && entry.after?.declaration.name === "hidden");

    expect(report).toMatchObject({
      language: "go", availability: "available",
      before: { providerId: "go-gopls-symbol-use", availability: "available" },
      after: { providerId: "go-gopls-symbol-use", availability: "available" },
    });
    expect(matched?.before?.repositoryReferences).toContainEqual(expect.objectContaining({ file: "consumer.go", line: 3 }));
    expect(matched?.after?.repositoryReferences).toContainEqual(expect.objectContaining({ file: "consumer.go", line: 3 }));
  }, 60_000);
});
