import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ParserService } from "../../src/port/ParserService";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { resolveCrossFileAssertionScope, collectWrapperExports } from "../../src/test-governance/assertionContext";

const dir = join(tmpdir(), `openarch-assertion-context-${Date.now()}`);
const helper = join(dir, "test-helpers.ts");
const other = join(dir, "subject.ts");
const javaHelper = join(dir, "TestHelpers.java");
const pyHelper = join(dir, "test_helpers.py");
const goTarget = join(dir, "lease.go");

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(helper, `
    import { expect } from "vitest";
    export function validateThrows(fn: () => void) { try { fn(); throw new Error("did not throw"); } catch { expect(true).toBe(true); } }
    export const verifyCalled = (mock: { called: boolean }) => { expect(mock.called).toBe(true); };
    export function renderList(items: string[]) { return items.join(","); }
  `);
  writeFileSync(other, "export const subject = () => true;\n");
  writeFileSync(javaHelper, [
    "package demo;",
    "import static org.junit.jupiter.api.Assertions.assertNotNull;",
    "public class TestHelpers {",
    "  public void validateUserCreated(User u) { assertNotNull(u); assertEquals(\"active\", u.status); }",
    "  public String render(User u) { return u.toString(); }",
    "}",
  ].join("\n"));
  writeFileSync(pyHelper, [
    "def validate_created(entity):",
    "    assert entity is not None",
    "def render(entity):",
    "    return str(entity)",
  ].join("\n"));
  writeFileSync(goTarget, "package lease\n\nfunc Acquire() bool { return true }\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const parserIn = () => Effect.gen(function* () {
  const parser = yield* ParserService;
  return parser;
}).pipe(Effect.provide(TreeSitterParserLive));

describe("collectWrapperExports（跨文件 helper 断言，2026-08-12 调研落地）", () => {
  it("extracts TS exported functions whose body contains an assertion, regardless of name", async () => {
    const parser = await Effect.runPromise(parserIn());
    const names = await collectWrapperExports(parser, helper);
    expect(names.has("validateThrows")).toBe(true);
    expect(names.has("verifyCalled")).toBe(true);
    // 体内无断言的非包装导出不识别
    expect(names.has("renderList")).toBe(false);
    expect(names.has("expect")).toBe(false);
  }, 15000);

  it("extracts Java helper methods whose body contains a JUnit assertion", async () => {
    const parser = await Effect.runPromise(parserIn());
    const names = await collectWrapperExports(parser, javaHelper, "java");
    expect(names.has("validateUserCreated")).toBe(true);
    expect(names.has("render")).toBe(false);
  }, 15000);

  it("extracts Python helper functions whose body contains an assert statement", async () => {
    const parser = await Effect.runPromise(parserIn());
    const names = await collectWrapperExports(parser, pyHelper, "python");
    expect(names.has("validate_created")).toBe(true);
    expect(names.has("render")).toBe(false);
  }, 15000);
});

describe("resolveCrossFileAssertionScope", () => {
  it("aggregates wrapper names from imported helper files and skips production modules", async () => {
    const parser = await Effect.runPromise(parserIn());
    const cache = new Map<string, ReadonlySet<string>>();
    const scope = await resolveCrossFileAssertionScope(parser, [
      { resolvedPath: helper.replace(/\\/g, "/") },
      { resolvedPath: other.replace(/\\/g, "/") },
    ], new Set([other.replace(/\\/g, "/")]), cache);
    expect(scope.isWrapperCall("validateThrows")).toBe(true);
    expect(scope.isWrapperCall("verifyCalled")).toBe(true);
    expect(scope.isWrapperCall("renderList")).toBe(false);
    // production 模块被跳过（不解析为 helper）
    expect(cache.has(helper.replace(/\\/g, "/"))).toBe(true);
    expect(cache.has(other.replace(/\\/g, "/"))).toBe(false);
  }, 15000);

  it("infers language from extension in scope resolution", async () => {
    const parser = await Effect.runPromise(parserIn());
    const cache = new Map<string, ReadonlySet<string>>();
    const scope = await resolveCrossFileAssertionScope(parser, [
      { resolvedPath: javaHelper.replace(/\\/g, "/") },
      { resolvedPath: pyHelper.replace(/\\/g, "/") },
    ], new Set(), cache);
    expect(scope.isWrapperCall("validateUserCreated")).toBe(true);
    expect(scope.isWrapperCall("validate_created")).toBe(true);
    expect(scope.isWrapperCall("render")).toBe(false);
  }, 15000);

  it("skips unsupported languages without running cross-language queries", async () => {
    const parser = await Effect.runPromise(parserIn());
    const cache = new Map<string, ReadonlySet<string>>();
    const scope = await resolveCrossFileAssertionScope(parser, [
      { resolvedPath: goTarget.replace(/\\/g, "/") },
    ], new Set(), cache);
    expect(scope.isWrapperCall("Acquire")).toBe(false);
    expect(cache.size).toBe(0);
  }, 15000);

  it("reuses the cache: second scope build does not re-parse the helper", async () => {
    const parser = await Effect.runPromise(parserIn());
    const cache = new Map<string, ReadonlySet<string>>();
    const helperPath = helper.replace(/\\/g, "/");
    await resolveCrossFileAssertionScope(parser, [{ resolvedPath: helperPath }], new Set(), cache);
    // 预热后缓存命中：再次构建不再新增缓存条目（条数不变）
    const second = await resolveCrossFileAssertionScope(parser, [{ resolvedPath: helperPath }], new Set(), cache);
    expect(second.isWrapperCall("validateThrows")).toBe(true);
    expect(cache.size).toBe(1);
  }, 15000);
});
