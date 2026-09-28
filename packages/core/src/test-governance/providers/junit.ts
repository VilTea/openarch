import { Effect } from "effect";
import type { QueryCapture, QueryMatch, ParserService } from "../../port/ParserService";
import type { TestCaseMetric, TestFindingInput } from "../../domain/testGovernance";
import type { TestFrameworkProvider, TestProviderContext, TestProviderResult } from "../provider";
import { capturesInTestBody, controlFlowInTestBody } from "../controlFlow";
import {
  declaresExpectedFailure, declaresJunitRule, isJunitAssertionMethod, isJunitImport, isJunitRuleAssertionMethod,
  isMockitoImport, isMockitoVerificationMethod,
} from "../assertionRecognition";
import { toPosixPath } from "../../infra/paths";

const methodPattern = `(method_declaration (modifiers) @modifiers name: (identifier) @name body: (block) @body) @method`;
/** 任意方法（含无修饰符的 helper/包装方法），用于断言包装作用域识别。 */
const anyMethodPattern = `(method_declaration name: (identifier) @name body: (block) @body) @method`;
/**
 * 测试体内的**任一具名子节点**（`(_)` 通配 = "块里至少有一条语句"）。
 *
 * 用于 `@Test(expected=…)` 的"体非空"判定：`(_)` 是语法事实，不需要维护语句类型名单
 * （名单即平行实现）。注意 tree-sitter 把注释也作为具名子节点，因此
 * `{ /* 只有注释 *\/ }` 会算作"非空"——方向是**漏报**（少报一个 missing_assertion），
 * 与本规则"漏报方向安全"的既有纪律一致，故不额外过滤。
 */
const statementPattern = `(method_declaration name: (identifier) @name body: (block (_) @statement)) @method`;
const importPattern = `(import_declaration) @import`;
const callPattern = `(method_invocation name: (identifier) @name) @call`;
const controlFlowPattern = `[(if_statement) @full (switch_expression) @full (switch_label) @case]`;
const nestedFunctionPattern = `[(lambda_expression) @nested (method_declaration) @nested (constructor_declaration) @nested]`;
/** 字段声明（含注解/修饰符）：用于 D-G1 的 `@Rule`/`@ClassRule` 门控。 */
const ruleFieldPattern = `(field_declaration (modifiers) @modifiers) @field`;

// JUnit 断言识别（校准 2026-08-12 体验反馈）：标准 assert* 方法族（唯一权威见
// ../assertionRecognition）+ 同文件内定义且体内含标准断言的包装方法（语法级作用域，
// 不依赖命名前缀）+ 注解级期望异常（缺陷 2 修复，规则同样来自 ../assertionRecognition）。

interface JunitCandidate {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly line: number;
  readonly startIndex?: number;
  readonly endIndex?: number;
  readonly statuses: readonly string[];
  /** `@Test(expected = X.class)` 声明的验证意图（注解级事实，判定见 assertionRecognition）。 */
  readonly expectsFailure: boolean;
}

const capture = (match: QueryMatch, name: string) => match.captures.find((item) => item.name === name);
const normalized = (file: string): string => toPosixPath(file);
const isTestFile = (file: string): boolean => /(^|\/)src\/test\/java\//i.test(normalized(file)) || /(?:Test|Tests|IT)\.java$/i.test(file);
const annotationNames = (modifiers: string): readonly string[] => [...modifiers.matchAll(/@(?:[\w.]+\.)?([A-Za-z_]\w*)\b/g)].map((match) => match[1]);
const hasJunitImport = (imports: readonly QueryMatch[]): boolean => imports.some((entry) => isJunitImport(capture(entry, "import")?.text ?? ""));
const hasMockitoImport = (imports: readonly QueryMatch[]): boolean => imports.some((entry) => isMockitoImport(capture(entry, "import")?.text ?? ""));

const candidates = (methods: readonly QueryMatch[], junitImported: boolean): readonly JunitCandidate[] => methods.flatMap((method) => {
  const modifiers = capture(method, "modifiers");
  const name = capture(method, "name");
  const body = capture(method, "body");
  if (!modifiers || !name || !body) return [];
  const annotations = annotationNames(modifiers.text);
  const qualifiedJUnitTest = /@org\.junit(?:\.|\b)/.test(modifiers.text) && annotations.includes("Test");
  if (!annotations.includes("Test") || (!junitImported && !qualifiedJUnitTest)) return [];
  const statuses = annotations.some((annotation) => annotation === "Disabled" || annotation === "Ignore") ? ["ignored"] : [];
  return [{
    name: name.text, startLine: body.startLine ?? 1, endLine: body.endLine ?? body.startLine ?? 1,
    line: name.startLine ?? 1, startIndex: body.startIndex, endIndex: body.endIndex, statuses,
    expectsFailure: declaresExpectedFailure(modifiers.text),
  }];
});

export const JUNIT_PROVIDER_ID = "java-junit";

/** JUnit 4/5 standard syntax + Mockito verification. Custom annotations, parameterized tests, stubbing and framework lifecycle remain outside this static provider. */
export const junitProvider: TestFrameworkProvider = {
    id: JUNIT_PROVIDER_ID,
  label: "JUnit 4/5（Java）",
  supports: isTestFile,
  collect: async (file: string, parser: ParserService, context?: TestProviderContext): Promise<TestProviderResult> => {
    const [methods, imports, calls, controlFlow, nested, anyMethods, statements, ruleFields] = await Promise.all([
      Effect.runPromise(parser.query(file, methodPattern)), Effect.runPromise(parser.query(file, importPattern)),
      Effect.runPromise(parser.query(file, callPattern)), Effect.runPromise(parser.query(file, controlFlowPattern)),
      Effect.runPromise(parser.query(file, nestedFunctionPattern)), Effect.runPromise(parser.query(file, anyMethodPattern)),
      Effect.runPromise(parser.query(file, statementPattern)), Effect.runPromise(parser.query(file, ruleFieldPattern)),
    ]);
    const tests = candidates(methods, hasJunitImport(imports));
    const mockitoImported = hasMockitoImport(imports);
    // D-G1（2026-09-25 实地核实）：`@Rule`/`@ClassRule` 委托式断言的门控。
    // 文件里声明了规则成员（字段或方法）时，`expect/expectMessage/expectCause/checkThat/
    // checkSucceeds/addError` 才算断言——它们把断言委托给规则对象，测试体内没有 `assert*`。
    // 判据与 `mockitoImported` 同形状：文件级事实 + 方法名名单（名单的唯一权威在
    // ../assertionRecognition，provider 不复写）。
    const ruleDeclared = [...ruleFields, ...methods].some((match) => declaresJunitRule(capture(match, "modifiers")?.text ?? ""));
    const isAssertionCall = (name: string | undefined): boolean =>
      isJunitAssertionMethod(name)
      || (mockitoImported && isMockitoVerificationMethod(name))
      || (ruleDeclared && isJunitRuleAssertionMethod(name));
    // 语法级断言作用域（校准 2026-08-12）：测试类/基类内定义、体内含标准 JUnit
    // 断言的方法视为断言包装（自定义 helper 不依赖命名前缀）。
    // 用 startIndex/endIndex（0-based 字节偏移）而非行号：与 capturesInTestBody 一致，
    // 避免不同 provider 的行号语义差异。
    //
    // 缺陷修复（2026-09-25 实地核实，`.research/openarch-java-junit`）：原实现只解析**一跳**，
    // 于是两跳链被判成"无断言"。JUnit 自己的 `TemporaryFolderUsageTest` 就是反例：
    // 用例体 → `assertFileIsDirectory` → `checkFileExists`（体内才是 `assertThat`）。
    // 现在按**传递闭包**求包装集合（同文件、有界：只在新增包装时继续），并显式排除自递归
    // （`c.text !== name`），否则一个自调用方法会把自己变成包装。
    const ownedCalls = (method: QueryMatch): readonly QueryCapture[] => {
      const body = capture(method, "body");
      if (body?.startIndex === undefined || body.endIndex === undefined) return [];
      return capturesInTestBody({ startIndex: body.startIndex, endIndex: body.endIndex }, calls, nested, "name");
    };
    // 名字可能被**多次声明**（重载/覆写/匿名类里的 `evaluate()`）。按名字**并集**累计调用，
    // 不能按名字覆盖——覆盖会让"某一个声明含断言"被后一个不含断言的声明抹掉，方向恰好是
    // **误报**（`FailOnTimeoutTest` 的 6 个 `evaluate()` 就是这么把整文件变成误报的）。
    // 名字级判据本身不可靠，但取并集是"漏报方向安全"的那一侧，与既有纪律一致。
    const methodCalls = new Map<string, QueryCapture[]>();
    for (const method of anyMethods) {
      const name = capture(method, "name")?.text;
      if (!name) continue;
      methodCalls.set(name, [...(methodCalls.get(name) ?? []), ...ownedCalls(method)]);
    }
    const wrapperNames = new Set<string>();
    for (let changed = true; changed;) {
      changed = false;
      for (const [name, owned] of methodCalls) {
        if (wrapperNames.has(name)) continue;
        if (owned.some((call) => isAssertionCall(call.text) || (call.text !== name && wrapperNames.has(call.text)))) {
          wrapperNames.add(name);
          changed = true;
        }
      }
    }
    // 缺陷 2 修复：`@Test(expected = X.class)` 是注解级异常断言。仅当测试体**非空**时才算
    // "已识别验证"——空体 + expected 在 JUnit 4 下必然失败（X 不会抛出），仍按
    // missing_assertion 报告（漏报方向安全）。规则本体在 ../assertionRecognition。
    //
    // 缺陷修复（2026-09-25 实地核实，`.research/openarch-java-junit`）：原判据写作
    // `bodyCalls.length > 0`（只数 `method_invocation`），于是**体里只有构造调用**
    // 的用例被当成空体——`@Test(expected = NullPointerException.class)` +
    // `new ErrorReportingRunner(null, new RuntimeException());` 被判 missing_assertion，
    // 而这句话是实打实会抛的语句（JUnit 自己 4 处：ErrorReportingRunnerTest；
    // 另有 TestClassTest / AllTestsTest 同形）。注释写的意图是"体非空"，
    // 实现却退化成了"体里有方法调用"——判据与自身意图不一致。
    const cases = tests.map((test) => {
      const bodyCalls = capturesInTestBody(test, calls, nested, "name");
      const bodyHasStatement = capturesInTestBody(test, statements, nested, "statement").length > 0;
      const assertedByBody = bodyCalls.filter((call) =>
        isAssertionCall(call.text) || wrapperNames.has(call.text) || context?.isCrossFileWrapperCall(call.text) === true).length;
      const assertedByAnnotation = test.expectsFailure && bodyHasStatement ? 1 : 0;
      return {
        test,
        emptyBody: !bodyHasStatement,
        metric: {
          name: test.name, loc: Math.max(0, test.endLine - test.startLine + 1),
          assertionCount: assertedByBody + assertedByAnnotation,
          mockCount: 0, statuses: test.statuses, testBodyControlFlow: controlFlowInTestBody(test, controlFlow, nested),
        },
      };
    });
    const metrics: TestCaseMetric[] = cases.map(({ metric }) => metric);
    const findings: TestFindingInput[] = tests.filter((test) => test.statuses.includes("ignored")).map((test) => ({
      ruleId: "java-junit.disabled-test", kind: "unapproved_skip", file, testName: test.name, line: test.line,
      evidence: ["@Disabled/@Ignore on recognised JUnit @Test method"], confidence: "high" as const,
    }));
    for (const { test, metric, emptyBody } of cases) {
      if (metric.assertionCount !== 0 || metric.statuses.includes("ignored")) continue;
      // D-G6（2026-09-25，项目所有者批准）：空体与"有语句但无断言"是两个不同事实，
      // 分列 kind。实测语料：409 条 missing_assertion 里 193 条体为空，而 JUnit 套件里
      // 它们多是被测**夹具类**（嵌套 static class 的 @Test 只是外层元测试的素材），
      // 混在同一 kind 下信噪比约 1:1。
      // 迁移语义（已记录）：按 `missing_assertion` 配置规则的策略**不再命中空体**，
      // 需要治理空体的项目须显式声明 `empty_test_body`。
      findings.push(emptyBody
        ? {
          ruleId: "java-junit.empty-test-body", kind: "empty_test_body", file, testName: test.name, line: test.line,
          evidence: ["recognised JUnit @Test method with an empty body (no statement)"], confidence: "low" as const,
        }
        : {
          ruleId: "java-junit.missing-known-assertion", kind: "missing_assertion", file, testName: test.name, line: test.line,
          evidence: [mockitoImported
            ? "no recognised JUnit assertion or Mockito verification in test body"
            : "no recognised JUnit assertion in test body"],
          confidence: "low" as const,
        });
    }
    return {
      tests: metrics,
      testCaseSpans: tests.map(({ name, startLine, endLine, statuses }) => ({ name, startLine, endLine, statuses })),
      findings,
    };
  },
};
