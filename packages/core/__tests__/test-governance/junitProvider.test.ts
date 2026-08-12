import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ParserService } from "../../src/port/ParserService";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { junitProvider } from "../../src/test-governance/providers/junit";

const dir = join(tmpdir(), `openarch-junit-provider-${Date.now()}`);
const file = join(dir, "src", "test", "java", "demo", "SampleTest.java");
const collect = () => Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* Effect.promise(() => junitProvider.collect(file, parser));
}).pipe(Effect.provide(TreeSitterParserLive));

beforeAll(() => {
  mkdirSync(join(dir, "src", "test", "java", "demo"), { recursive: true });
  writeFileSync(file, [
    "package demo;", "import org.junit.jupiter.api.Disabled;", "import org.junit.jupiter.api.Test;", "import static org.junit.jupiter.api.Assertions.assertEquals;", "import static org.junit.jupiter.api.Assertions.assertThat;",
    "class SampleTest {",
    "  @Test void works() { if (true) { assertEquals(2, 1 + 1); } }",
    "  @Test @Disabled void disabled() { assertEquals(1, 1); }",
    "  @Test void noAssertion() { Runnable nested = () -> { assertEquals(1, 1); }; nested.run(); }",
    "  @Test void hamcrest() { assertThat(1 + 1, equalTo(2)); }",
    "  void validateUserCreated(User u) { assertNotNull(u); assertEquals(\"active\", u.status); }",
    "  @Test void customHelper() { validateUserCreated(user); }",
    "}",
  ].join("\n"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("junitProvider", () => {
  it("collects standard JUnit tests while preserving disabled and nested-lambda boundaries", async () => {
    const result = await Effect.runPromise(collect());
    expect(result.tests).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "works", assertionCount: 1, testBodyControlFlow: 1 }),
      expect.objectContaining({ name: "disabled", statuses: ["ignored"] }),
      expect.objectContaining({ name: "noAssertion", assertionCount: 0 }),
      expect.objectContaining({ name: "hamcrest", assertionCount: 1 }),
      // P3（2026-08-12 体验反馈）：同文件内体内含断言的包装方法（非前缀命名）不再误扫
      expect.objectContaining({ name: "customHelper", assertionCount: 1 }),
    ]));
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "java-junit.disabled-test", testName: "disabled", confidence: "high" }),
      expect.objectContaining({ ruleId: "java-junit.missing-known-assertion", testName: "noAssertion", confidence: "low" }),
    ]));
  });

  it("counts cross-file helper calls as assertions via provider context", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const parser = yield* ParserService;
      return yield* Effect.promise(() => junitProvider.collect(file, parser, {
        isCrossFileWrapperCall: (callee) => callee === "validateUserCreated",
      }));
    }).pipe(Effect.provide(TreeSitterParserLive)));
    // noAssertion 方法体内没有调用包装 helper → 仍为 0
    expect(result.tests.find((test) => test.name === "noAssertion")?.assertionCount).toBe(0);
  });
});
