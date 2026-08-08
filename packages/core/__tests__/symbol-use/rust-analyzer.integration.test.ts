import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { collectRustSymbolUse } from "../../src/adapter/symbol-use/RustSymbolUseProvider";
import { ParserService } from "../../src/port/ParserService";

const roots: string[] = [];
const rustAnalyzer = process.env.OPENARCH_RUST_ANALYZER_PATH;
const calibrationCwd = process.env.OPENARCH_RUST_CALIBRATION_CWD;
const buildScriptCalibrationCwd = process.env.OPENARCH_RUST_BUILDSCRIPT_CALIBRATION_CWD;
const enabled = process.env.OPENARCH_RUST_ANALYZER_INTEGRATION === "1" && Boolean(rustAnalyzer);

const project = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "openarch-rust-symbol-use-"));
  roots.push(cwd);
  writeFileSync(join(cwd, "Cargo.toml"), [
    "[package]",
    "name = \"symbol-use\"",
    "version = \"0.1.0\"",
    "edition = \"2024\"",
  ].join("\n"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "lib.rs"), "mod producer;\n\npub(crate) fn use_value() -> &'static str { producer::hidden() }\n");
  writeFileSync(join(cwd, "src", "producer.rs"), "pub(crate) fn hidden() -> &'static str { \"ok\" }\n");
  return cwd;
};

const collect = (cwd: string) => Effect.runPromise(Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* collectRustSymbolUse({ cwd, languages: ["rust"] }, { parser, executable: rustAnalyzer! });
}).pipe(Effect.provide(TreeSitterParserLive)));

afterEach(async () => {
  // rust-analyzer releases file handles shortly after the LSP exit notification on Windows.
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe("rust-analyzer symbol-use calibration", () => {
  it.skipIf(!enabled)("waits for diagnostics before resolving private cross-file references", async () => {
    const cwd = project();
    const report = await collect(cwd);

    expect(report.state).toMatchObject({
      availability: "available",
      coverage: { declarations: "complete", repositoryReferences: "complete" },
    });
    expect(report.facts.map((fact) => fact.declaration)).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "src/producer.rs", name: "hidden" }),
      expect.objectContaining({ file: "src/lib.rs", name: "use_value" }),
    ]));
    expect(report.facts).toContainEqual(expect.objectContaining({
      declaration: expect.objectContaining({ file: "src/producer.rs", name: "hidden" }),
      repositoryReferences: expect.arrayContaining([expect.objectContaining({ file: "src/lib.rs", line: 3 })]),
    }));
  }, 45_000);

  it.skipIf(!enabled || !calibrationCwd)("reports a macro, cfg, and workspace example as partial without discarding facts", async () => {
    const report = await collect(calibrationCwd!);

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
    });
    expect(report.reason).toContain("macro expansion");
    expect(report.reason).toContain("conditional compilation");
    expect(report.reason).toContain("Cargo workspace");
    expect(report.facts.length).toBeGreaterThan(0);
  }, 120_000);

  it.skipIf(!enabled || !buildScriptCalibrationCwd)("reports an external build-script and proc-macro workspace as partial without discarding facts", async () => {
    const report = await collect(buildScriptCalibrationCwd!);

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
    });
    expect(report.reason).toContain("build scripts");
    expect(report.reason).toContain("macro expansion");
    expect(report.reason).toContain("Cargo workspace");
    expect(report.facts.length).toBeGreaterThan(0);
  }, 120_000);

  it.skipIf(!enabled)("keeps macro invocation partial while retaining a direct cross-file reference", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "src", "lib.rs"), [
      "mod producer;",
      "macro_rules! marker { () => { 1 }; }",
      "const _: i32 = marker!();",
      "pub(crate) fn use_value() -> &'static str { producer::hidden() }",
    ].join("\n"));

    const report = await collect(cwd);

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      reason: expect.stringContaining("macro expansion"),
    });
    expect(report.facts).toContainEqual(expect.objectContaining({
      declaration: expect.objectContaining({ file: "src/producer.rs", name: "hidden" }),
      repositoryReferences: expect.arrayContaining([expect.objectContaining({ file: "src/lib.rs", line: 4 })]),
    }));
  }, 60_000);

  it.skipIf(!enabled)("keeps conditional compilation partial while retaining a direct cross-file reference", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "src", "lib.rs"), [
      "mod producer;",
      "#[cfg(any())]",
      "const IGNORED: i32 = 1;",
      "pub(crate) fn use_value() -> &'static str { producer::hidden() }",
    ].join("\n"));

    const report = await collect(cwd);

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      reason: expect.stringContaining("conditional compilation"),
    });
    expect(report.facts).toContainEqual(expect.objectContaining({
      declaration: expect.objectContaining({ file: "src/producer.rs", name: "hidden" }),
      repositoryReferences: expect.arrayContaining([expect.objectContaining({ file: "src/lib.rs", line: 4 })]),
    }));
  }, 60_000);

  it.skipIf(!enabled)("keeps a Cargo workspace manifest partial while retaining a direct cross-file reference", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "Cargo.toml"), [
      "[package]",
      "name = \"symbol-use\"",
      "version = \"0.1.0\"",
      "edition = \"2024\"",
      "[workspace]",
      "members = []",
    ].join("\n"));

    const report = await collect(cwd);

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "complete", repositoryReferences: "partial" },
      reason: expect.stringContaining("Cargo workspace"),
    });
    expect(report.facts).toContainEqual(expect.objectContaining({
      declaration: expect.objectContaining({ file: "src/producer.rs", name: "hidden" }),
      repositoryReferences: expect.arrayContaining([expect.objectContaining({ file: "src/lib.rs", line: 3 })]),
    }));
  }, 60_000);

  it.skipIf(!enabled)("keeps a build-script crate partial while retaining a direct cross-file reference", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "build.rs"), "fn main() {}\n");

    const report = await collect(cwd);

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      reason: expect.stringContaining("build scripts"),
    });
    expect(report.facts).toContainEqual(expect.objectContaining({
      declaration: expect.objectContaining({ file: "src/producer.rs", name: "hidden" }),
      repositoryReferences: expect.arrayContaining([expect.objectContaining({ file: "src/lib.rs", line: 3 })]),
    }));
  }, 60_000);

  it.skipIf(!enabled)("keeps derive macro expansion partial while retaining a direct cross-file reference", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "src", "lib.rs"), [
      "mod producer;",
      "#[derive(Clone)]",
      "struct Marker;",
      "pub(crate) fn use_value() -> &'static str { producer::hidden() }",
    ].join("\n"));

    const report = await collect(cwd);

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      reason: expect.stringContaining("derive or proc-macro expansion"),
    });
    expect(report.facts).toContainEqual(expect.objectContaining({
      declaration: expect.objectContaining({ file: "src/producer.rs", name: "hidden" }),
      repositoryReferences: expect.arrayContaining([expect.objectContaining({ file: "src/lib.rs", line: 4 })]),
    }));
  }, 60_000);

  it.skipIf(!enabled)("keeps a path attribute macro partial while retaining a direct cross-file reference", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "src", "lib.rs"), [
      "mod producer;",
      "#[framework::entry]",
      "pub(crate) fn use_value() -> &'static str { producer::hidden() }",
    ].join("\n"));

    const report = await collect(cwd);

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      reason: expect.stringContaining("path attribute macros"),
    });
    expect(report.facts).toContainEqual(expect.objectContaining({
      declaration: expect.objectContaining({ file: "src/producer.rs", name: "hidden" }),
      repositoryReferences: expect.arrayContaining([expect.objectContaining({ file: "src/lib.rs", line: 3 })]),
    }));
  }, 60_000);
});
