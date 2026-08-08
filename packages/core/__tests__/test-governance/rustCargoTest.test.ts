import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ParserService } from "../../src/port/ParserService";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { cargoTestRunner } from "../../src/test-governance/runners/cargoTest";
import { rustCargoTestProvider } from "../../src/test-governance/providers/rustCargoTest";

const dir = join(tmpdir(), `openarch-rust-testing-${Date.now()}`);
const testFile = join(dir, "tests", "integration.rs");

const collect = () => Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* Effect.promise(() => rustCargoTestProvider.collect(testFile, parser));
}).pipe(Effect.provide(TreeSitterParserLive));

beforeAll(() => {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"openarch_rust_testing\"\nversion = \"0.1.0\"\nedition = \"2024\"\n");
  writeFileSync(join(dir, "src", "lib.rs"), "pub fn answer() -> u32 { 42 }\n");
  writeFileSync(testFile, [
    "fn verify_roundtrip() { assert!(true); }",
    "#[test]",
    "fn works() { assert_eq!(2 + 2, 4); }",
    "#[test]",
    "#[ignore = \"slow\"]",
    "fn ignored() { assert!(true); }",
    "#[test]",
    "fn no_assertion() { let value = 42; let _ = value; }",
    "#[test]",
    "fn delegated() { verify_roundtrip(); }",
  ].join("\n"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("rustCargoTestProvider", () => {
  it("collects standard integration tests, assertions, and ignore attributes", async () => {
    const result = await Effect.runPromise(collect());
    expect(result.tests).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "works", assertionCount: 1 }),
      expect.objectContaining({ name: "ignored", assertionCount: 1, statuses: ["ignored"] }),
    ]));
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "rust-cargo-test.ignore-attribute", testName: "ignored" }),
      expect.objectContaining({ ruleId: "rust-cargo-test.missing-known-assertion", testName: "no_assertion", confidence: "low" }),
    ]));
    // 委托断言（测试体调用辅助函数）不报 missing_assertion——Rust idiom，校准 2026-08-08
    expect(result.findings.some((finding) => finding.kind === "missing_assertion" && finding.testName === "delegated")).toBe(false);
    expect(result.testCaseSpans).toContainEqual(expect.objectContaining({ name: "ignored", statuses: ["ignored"] }));
  });

  it("executes cargo test only through the runner contract", async () => {
    await expect(cargoTestRunner.run(dir)).resolves.toMatchObject({ passed: true, command: "cargo test --quiet" });
  }, 30000);
});
