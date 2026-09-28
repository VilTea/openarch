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
const mockitoFile = join(dir, "src", "test", "java", "demo", "MockitoSampleTest.java");
const annotationFile = join(dir, "src", "test", "java", "demo", "AnnotationExpectationTest.java");
const chainFile = join(dir, "src", "test", "java", "demo", "WrapperChainTest.java");
const ruleFile = join(dir, "src", "test", "java", "demo", "RuleDelegationTest.java");
const lookalikeFile = join(dir, "src", "test", "java", "demo", "RuleLookalikeTest.java");
const collect = () => Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* Effect.promise(() => junitProvider.collect(file, parser));
}).pipe(Effect.provide(TreeSitterParserLive));
const collectMockito = () => Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* Effect.promise(() => junitProvider.collect(mockitoFile, parser));
}).pipe(Effect.provide(TreeSitterParserLive));
const collectAnnotation = () => Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* Effect.promise(() => junitProvider.collect(annotationFile, parser));
}).pipe(Effect.provide(TreeSitterParserLive));
const collectChain = () => Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* Effect.promise(() => junitProvider.collect(chainFile, parser));
}).pipe(Effect.provide(TreeSitterParserLive));
const collectRule = () => Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* Effect.promise(() => junitProvider.collect(ruleFile, parser));
}).pipe(Effect.provide(TreeSitterParserLive));
const collectLookalike = () => Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* Effect.promise(() => junitProvider.collect(lookalikeFile, parser));
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
  writeFileSync(mockitoFile, [
    "package demo;", "import org.junit.jupiter.api.Test;",
    "import static org.mockito.Mockito.verify;", "import static org.mockito.Mockito.atLeastOnce;",
    "import static org.mockito.ArgumentMatchers.eq;", "import static org.mockito.ArgumentMatchers.argThat;",
    "class MockitoSampleTest {",
    "  @Test void verifyArgs() { verify(proxyService, atLeastOnce()).post(eq(path), argThat(params -> params.id == 1)); }",
    "  @Test void noMockitoAssertion() { helper(); }",
    "  void assertVerified(Service proxy) { verify(proxy); }",
    "  @Test void usesMockitoHelper() { assertVerified(proxyService); }",
    "}",
  ].join("\n"));
  writeFileSync(annotationFile, [
    "package demo;", "import org.junit.Test;",
    "class AnnotationExpectationTest {",
    "  Service service = new Service();",
    "  @Test(expected = IllegalStateException.class) void expectsFailure() { service.call(); }",
    "  @Test(expected=IllegalStateException.class) void expectsFailureTight() { service.call(); }",
    "  @Test(timeout = 1000, expected = IllegalStateException.class) void expectsFailureWithTimeout() { service.call(); }",
    "  @Test(expected = IllegalStateException.class) void expectsButEmpty() { }",
    "  @Test(expected = IllegalStateException.class) void expectsButEmptyWithComment() { /* no statement */ }",
    "  @Test(expected = NullPointerException.class) void expectsButOnlyConstructs() { new Service(); }",
    "  @Test void trulyEmpty() { }",
    "  @Test void callsWithoutExpectation() { service.call(); }",
    "}",
  ].join("\n"));
  writeFileSync(chainFile, [
    "package demo;", "import org.junit.Test;",
    "import static org.junit.Assert.assertThat;",
    "class WrapperChainTest {",
    "  @Test void twoHop() { assertFileIsDirectory(file); }",
    "  @Test void selfRecursive() { selfRecursive(); }",
    "  @Test void overloadUnion() { check(\"x\"); }",
    "  void assertFileIsDirectory(File file) { checkExists(file); }",
    "  void checkExists(File file) { assertThat(file, notNullValue()); }",
    "  void selfRecursive() { selfRecursive(); }",
    "  void check(String first) { }",
    "  void check(String first, int second) { assertThat(first, notNullValue()); }",
    "}",
  ].join("\n"));
  writeFileSync(ruleFile, [
    "package demo;", "import org.junit.Rule;", "import org.junit.ClassRule;", "import org.junit.Test;",
    "import org.junit.Assume;", "import org.junit.rules.ExpectedException;",
    "class RuleDelegationTest {",
    "  @Rule public ExpectedException thrown = ExpectedException.none();",
    "  @ClassRule public static final Timeout timeout = new Timeout();",
    "  @Test void expectsNullPointer() { thrown.expect(NullPointerException.class); thrown.expectMessage(\"boom\"); }",
    "  @Test void assumptionFailed() { Assume.assumeTrue(false); }",
    "}",
  ].join("\n"));
  // 门控对照：同一 `expect(...)` 调用，但文件**没有** `@Rule` 声明 ⇒ 不算断言。
  // 门控是文件级事实（与 mockitoImported 同形状），所以对照必须是独立文件。
  writeFileSync(lookalikeFile, [
    "package demo;", "import org.junit.Test;",
    "class RuleLookalikeTest {",
    "  @Test void expectLookalike() { notARule.expect(\"renderable\"); }",
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
      expect.objectContaining({ ruleId: "java-junit.missing-known-assertion", testName: "noAssertion", confidence: "low", line: expect.any(Number) }),
    ]));
  });

  it("attaches provider-observed line to every finding (defect 1: per-case locations)", async () => {
    const result = await Effect.runPromise(collect());
    const missing = result.findings.filter((finding) => finding.kind === "missing_assertion");
    expect(missing.length).toBeGreaterThan(0);
    for (const finding of missing) {
      expect(typeof finding.line).toBe("number");
      expect(finding.file.endsWith("SampleTest.java")).toBe(true);
    }
    // 姊妹 finding 的既有 line 语义不变
    expect(result.findings.find((finding) => finding.kind === "unapproved_skip")?.line).toBeGreaterThan(0);
  });

  it("counts Mockito verify as an assertion when org.mockito is imported", async () => {
    const result = await Effect.runPromise(collectMockito());
    expect(result.tests.find((test) => test.name === "verifyArgs")?.assertionCount).toBeGreaterThan(0);
    const missing = result.findings
      .filter((finding) => finding.ruleId === "java-junit.missing-known-assertion")
      .map((finding) => finding.testName);
    expect(missing).not.toContain("verifyArgs");
    expect(missing).toContain("noMockitoAssertion");
  });

  it("recognises a same-file helper that wraps Mockito verify (defect 2 boundary)", async () => {
    const result = await Effect.runPromise(collectMockito());
    expect(result.tests.find((test) => test.name === "usesMockitoHelper")?.assertionCount).toBeGreaterThan(0);
    const missing = result.findings
      .filter((finding) => finding.ruleId === "java-junit.missing-known-assertion")
      .map((finding) => finding.testName);
    expect(missing).not.toContain("usesMockitoHelper");
  });

  it("treats @Test(expected = X.class) as verification intent, but keeps truly empty bodies reported", async () => {
    const result = await Effect.runPromise(collectAnnotation());
    const assertionCountOf = (name: string) => result.tests.find((test) => test.name === name)?.assertionCount;
    expect(assertionCountOf("expectsFailure")).toBe(1);
    expect(assertionCountOf("expectsFailureTight")).toBe(1);
    expect(assertionCountOf("expectsFailureWithTimeout")).toBe(1);
    // 缺陷修复（2026-09-25 实地核实）：判据的**意图**是"体非空"，原实现却退化成
    // "体里有 method_invocation"，于是只有构造调用的体被误判为空体（JUnit 自己的
    // ErrorReportingRunnerTest/TestClassTest/AllTestsTest 都是 `new X(...)` + expected）。
    expect(assertionCountOf("expectsButOnlyConstructs")).toBe(1);
    const missing = result.findings
      .filter((finding) => finding.ruleId === "java-junit.missing-known-assertion")
      .map((finding) => finding.testName);
    const emptyBodies = result.findings
      .filter((finding) => finding.kind === "empty_test_body")
      .map((finding) => finding.testName);
    expect(missing).not.toContain("expectsFailure");
    expect(missing).not.toContain("expectsFailureTight");
    expect(missing).not.toContain("expectsFailureWithTimeout");
    expect(missing).not.toContain("expectsButOnlyConstructs");
    // D-G6：空体自成 kind，不再混进 missing_assertion（两者是不同事实）。
    expect(missing).toEqual(["callsWithoutExpectation"]);
    expect(emptyBodies.sort()).toEqual(["expectsButEmpty", "trulyEmpty"]);
    // 边界（有意记录）：注释体算"非空"（`(_)` 把注释也当具名子节点），方向是漏报
    // ⇒ 与"漏报方向安全"纪律一致，故它两个 kind 都不进。
    expect([...missing, ...emptyBodies]).not.toContain("expectsButEmptyWithComment");
    expect(result.findings.filter((finding) => finding.kind === "missing_assertion").every((finding) => typeof finding.line === "number")).toBe(true);
  });

  /** D-G1（2026-09-25 实地核实）：`@Rule` 委托式断言。 */
  it("counts @Rule-delegated assertions only when the file declares a rule member", async () => {
    const result = await Effect.runPromise(collectRule());
    const assertionCountOf = (name: string) => result.tests.find((test) => test.name === name)?.assertionCount;
    // 文件声明了 @Rule ExpectedException + @ClassRule → expect/expectMessage 算断言
    expect(assertionCountOf("expectsNullPointer")).toBe(2);
    const missing = result.findings
      .filter((finding) => finding.ruleId === "java-junit.missing-known-assertion")
      .map((finding) => finding.testName);
    expect(missing).not.toContain("expectsNullPointer");

    // 门控对照（独立文件，无 @Rule 声明）：同名 `expect(...)` 不算断言
    const lookalike = await Effect.runPromise(collectLookalike());
    expect(lookalike.tests.find((test) => test.name === "expectLookalike")?.assertionCount).toBe(0);
    expect(lookalike.findings.map((finding) => finding.testName)).toContain("expectLookalike");
  });

  /** D-G7（2026-09-25）：assumptions 是前置条件，不是断言——有意保留的边界。 */
  it("does not treat Assume.* assumptions as assertions (recorded boundary)", async () => {
    const result = await Effect.runPromise(collectRule());
    const assumption = result.findings.find((finding) => finding.testName === "assumptionFailed");
    expect(assumption?.kind).toBe("missing_assertion");
    expect(result.tests.find((test) => test.name === "assumptionFailed")?.assertionCount).toBe(0);
  });

  it("resolves transitive same-file assertion wrappers (multi-hop chains)", async () => {
    const result = await Effect.runPromise(collectChain());
    const assertionCountOf = (name: string) => result.tests.find((test) => test.name === name)?.assertionCount;
    // 用例体 → assertFileIsDirectory → checkFileExists（体内才是 assertThat）
    expect(assertionCountOf("twoHop")).toBe(1);
    // 自递归方法不能因为"调用了自己"而把自己变成断言包装
    expect(assertionCountOf("selfRecursive")).toBe(0);
    // 同名多声明（重载/覆写）取**并集**：某一个声明含断言即认名字为包装。
    // 覆盖式实现会让后一个不含断言的声明抹掉前一个（FailOnTimeoutTest 的 6 个 evaluate()）
    // 而制造误报。
    expect(assertionCountOf("overloadUnion")).toBe(1);
    const missing = result.findings
      .filter((finding) => finding.ruleId === "java-junit.missing-known-assertion")
      .map((finding) => finding.testName);
    expect(missing).not.toContain("twoHop");
    expect(missing).not.toContain("overloadUnion");
    expect(missing).toContain("selfRecursive");
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
