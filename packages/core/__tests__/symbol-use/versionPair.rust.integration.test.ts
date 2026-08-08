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
const rustAnalyzer = process.env.OPENARCH_RUST_ANALYZER_PATH;
const cargo = process.env.OPENARCH_CARGO_PATH;
const enabled = process.env.OPENARCH_RUST_ANALYZER_INTEGRATION === "1" && Boolean(rustAnalyzer && cargo);

const git = (cwd: string, args: readonly string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const project = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "openarch-symbol-version-rust-analyzer-"));
  roots.push(cwd);
  mkdirSync(join(cwd, ".openarch"), { recursive: true });
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, ".openarch", "config.yml"), "languages: [rust]\n");
  writeFileSync(join(cwd, "Cargo.toml"), [
    "[package]",
    "name = \"version_pair\"",
    "version = \"0.1.0\"",
    "edition = \"2024\"",
  ].join("\n") + "\n");
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
  collectLspSymbolVersionPair(cwd, "HEAD", "rust").pipe(
    Effect.provide(SymbolUseServiceLive),
    Effect.provide(SemanticToolchainDiscoveryLive),
    Effect.provide(TreeSitterParserLive),
  ),
);

afterEach(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 500));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe("Rust LSP version-paired symbol facts", () => {
  it.skipIf(!enabled)("collects rust-analyzer facts from isolated Git revision workspaces", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "src", "producer.rs"), "pub(crate) fn hidden() -> i32 { 1 }\n");
    writeFileSync(join(cwd, "src", "lib.rs"), "mod producer;\n\npub(crate) fn use_value() -> i32 { producer::hidden() }\n");
    commit(cwd, "before");
    writeFileSync(join(cwd, "src", "producer.rs"), "pub(crate) fn hidden() -> i32 { 2 }\n");
    commit(cwd, "after");

    const report = await collect(cwd);
    const matched = report.declarations.find((entry) => entry.status === "matched" && entry.after?.declaration.name === "hidden");

    expect(report).toMatchObject({
      language: "rust", availability: "available",
      before: { providerId: "rust-analyzer-symbol-use", availability: "available" },
      after: { providerId: "rust-analyzer-symbol-use", availability: "available" },
    });
    expect(matched?.before?.repositoryReferences).toContainEqual(expect.objectContaining({ file: "src/lib.rs", line: 3 }));
    expect(matched?.after?.repositoryReferences).toContainEqual(expect.objectContaining({ file: "src/lib.rs", line: 3 }));
  }, 90_000);

  it.skipIf(!enabled)("preserves Rust workspace partial boundaries across revisions", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "Cargo.toml"), [
      "[package]",
      "name = \"version_pair\"",
      "version = \"0.1.0\"",
      "edition = \"2024\"",
      "[workspace]",
      "members = []",
    ].join("\n") + "\n");
    writeFileSync(join(cwd, "src", "producer.rs"), "pub(crate) fn hidden() -> i32 { 1 }\n");
    writeFileSync(join(cwd, "src", "lib.rs"), "mod producer;\n\npub(crate) fn use_value() -> i32 { producer::hidden() }\n");
    commit(cwd, "before with workspace boundary");
    writeFileSync(join(cwd, "src", "producer.rs"), "pub(crate) fn hidden() -> i32 { 2 }\n");
    commit(cwd, "after with workspace boundary");

    const report = await collect(cwd);
    const matched = report.declarations.find((entry) => entry.status === "matched" && entry.after?.declaration.name === "hidden");

    expect(report).toMatchObject({
      language: "rust", availability: "partial",
      before: {
        providerId: "rust-analyzer-symbol-use", availability: "partial",
        coverage: { declarations: "complete", repositoryReferences: "partial" },
      },
      after: {
        providerId: "rust-analyzer-symbol-use", availability: "partial",
        coverage: { declarations: "complete", repositoryReferences: "partial" },
      },
    });
    expect(report.before?.reason).toContain("Cargo workspace");
    expect(report.after?.reason).toContain("Cargo workspace");
    expect(matched?.before?.repositoryReferences).toContainEqual(expect.objectContaining({ file: "src/lib.rs", line: 3 }));
    expect(matched?.after?.repositoryReferences).toContainEqual(expect.objectContaining({ file: "src/lib.rs", line: 3 }));
  }, 90_000);
});
