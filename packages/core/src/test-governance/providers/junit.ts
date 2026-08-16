import { Effect } from "effect";
import type { QueryMatch, ParserService } from "../../port/ParserService";
import type { TestCaseMetric, TestFindingInput } from "../../domain/testGovernance";
import type { TestFrameworkProvider, TestProviderContext, TestProviderResult } from "../provider";
import { capturesInTestBody, controlFlowInTestBody } from "../controlFlow";
import { toPosixPath } from "../../infra/paths";

const methodPattern = `(method_declaration (modifiers) @modifiers name: (identifier) @name body: (block) @body) @method`;
/** 任意方法（含无修饰符的 helper/包装方法），用于断言包装作用域识别。 */
const anyMethodPattern = `(method_declaration name: (identifier) @name body: (block) @body) @method`;
const importPattern = `(import_declaration) @import`;
const callPattern = `(method_invocation name: (identifier) @name) @call`;
const controlFlowPattern = `[(if_statement) @full (switch_expression) @full (switch_label) @case]`;
const nestedFunctionPattern = `[(lambda_expression) @nested (method_declaration) @nested (constructor_declaration) @nested]`;
const assertionMethods = new Set(["assertEquals", "assertNotEquals", "assertTrue", "assertFalse", "assertNull", "assertNotNull", "assertSame", "assertNotSame", "assertThrows", "assertThat", "assertArrayEquals", "assertDoesNotThrow", "assertIterableEquals", "fail"]);
/** Mockito 验证方法（体验反馈 2026-08-14 P1-3）：verify(...).foo(...) 是有效行为断言，
 *  静态分析不再把它误判为 missing_assertion。仅在检测到 org.mockito import 时启用，
 *  避免把业务代码里同名 verify 方法当作断言。 */
const mockitoVerificationMethods = new Set(["verify", "verifyNoInteractions", "verifyNoMoreInteractions", "verifyZeroInteractions"]);

// JUnit 断言识别（校准 2026-08-12 体验反馈）：标准 assert* 方法族 + 同文件内
// 定义且体内含标准断言的包装方法（语法级作用域，不依赖命名前缀）。

interface JunitCandidate {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly line: number;
  readonly startIndex?: number;
  readonly endIndex?: number;
  readonly statuses: readonly string[];
}

const capture = (match: QueryMatch, name: string) => match.captures.find((item) => item.name === name);
const normalized = (file: string): string => toPosixPath(file);
const isTestFile = (file: string): boolean => /(^|\/)src\/test\/java\//i.test(normalized(file)) || /(?:Test|Tests|IT)\.java$/i.test(file);
const annotationNames = (modifiers: string): readonly string[] => [...modifiers.matchAll(/@(?:[\w.]+\.)?([A-Za-z_]\w*)\b/g)].map((match) => match[1]);
const hasJunitImport = (imports: readonly QueryMatch[]): boolean => imports.some((entry) => /\b(?:static\s+)?org\.junit(?:\.|;)/.test(capture(entry, "import")?.text ?? ""));
const hasMockitoImport = (imports: readonly QueryMatch[]): boolean => imports.some((entry) => /\b(?:static\s+)?org\.mockito(?:\.|;)/.test(capture(entry, "import")?.text ?? ""));

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
  }];
});

export const JUNIT_PROVIDER_ID = "java-junit";

/** JUnit 4/5 standard syntax + Mockito verification. Custom annotations, parameterized tests, stubbing and framework lifecycle remain outside this static provider. */
export const junitProvider: TestFrameworkProvider = {
    id: JUNIT_PROVIDER_ID,
  label: "JUnit 4/5（Java）",
  supports: isTestFile,
  collect: async (file: string, parser: ParserService, context?: TestProviderContext): Promise<TestProviderResult> => {
    const [methods, imports, calls, controlFlow, nested, anyMethods] = await Promise.all([
      Effect.runPromise(parser.query(file, methodPattern)), Effect.runPromise(parser.query(file, importPattern)),
      Effect.runPromise(parser.query(file, callPattern)), Effect.runPromise(parser.query(file, controlFlowPattern)),
      Effect.runPromise(parser.query(file, nestedFunctionPattern)), Effect.runPromise(parser.query(file, anyMethodPattern)),
    ]);
    const tests = candidates(methods, hasJunitImport(imports));
    const mockitoImported = hasMockitoImport(imports);
    const isAssertionCall = (name: string | undefined): boolean =>
      name !== undefined && (assertionMethods.has(name) || (mockitoImported && mockitoVerificationMethods.has(name)));
    // 语法级断言作用域（校准 2026-08-12）：测试类/基类内定义、体内含标准 JUnit
    // 断言的方法视为断言包装（自定义 helper 不依赖命名前缀）。
    // 用 startIndex/endIndex（0-based 字节偏移）而非行号：与 capturesInTestBody 一致，
    // 避免不同 provider 的行号语义差异。
    const standardAssertionCalls = calls.filter((match) => isAssertionCall(capture(match, "name")?.text));
    const wrapperNames = new Set<string>();
    for (const method of anyMethods) {
      const name = capture(method, "name")?.text;
      const bodyStart = capture(method, "body")?.startLine;
      const bodyEnd = capture(method, "body")?.endLine;
      if (name && bodyStart !== undefined && bodyEnd !== undefined
        && standardAssertionCalls.some((call) => {
          const callLine = capture(call, "call")?.startLine;
          return callLine !== undefined && callLine >= bodyStart && callLine <= bodyEnd;
        })) {
        wrapperNames.add(name);
      }
    }
    const metrics: TestCaseMetric[] = tests.map((test) => ({
      name: test.name, loc: Math.max(0, test.endLine - test.startLine + 1),
      assertionCount: capturesInTestBody(test, calls, nested, "name").filter((call) =>
        isAssertionCall(call.text) || wrapperNames.has(call.text) || context?.isCrossFileWrapperCall(call.text) === true).length,
      mockCount: 0, statuses: test.statuses, testBodyControlFlow: controlFlowInTestBody(test, controlFlow, nested),
    }));
    const findings: TestFindingInput[] = tests.filter((test) => test.statuses.includes("ignored")).map((test) => ({
      ruleId: "java-junit.disabled-test", kind: "unapproved_skip", file, testName: test.name, line: test.line,
      evidence: ["@Disabled/@Ignore on recognised JUnit @Test method"], confidence: "high" as const,
    }));
    for (const test of metrics.filter((test) => test.assertionCount === 0 && !test.statuses.includes("ignored"))) findings.push({
      ruleId: "java-junit.missing-known-assertion", kind: "missing_assertion", file, testName: test.name,
      evidence: [mockitoImported
        ? "no recognised JUnit assertion or Mockito verification in test body"
        : "no recognised JUnit assertion in test body"],
      confidence: "low" as const,
    });
    return {
      tests: metrics,
      testCaseSpans: tests.map(({ name, startLine, endLine, statuses }) => ({ name, startLine, endLine, statuses })),
      findings,
    };
  },
};
