import { Effect } from "effect";
import type { QueryCapture, QueryMatch, ParserService } from "../../port/ParserService";
import type { TestCaseMetric } from "../../domain/testGovernance";
import type { TestFrameworkProvider, TestProviderResult } from "../provider";
import { capturesInTestBody, controlFlowInTestBody } from "../controlFlow";
import { toPosixPath } from "../../infra/paths";

const testFunctionPattern = `
(function_declaration
  name: (identifier) @name
  parameters: (parameter_list) @parameters
  body: (block) @body) @function
`;
const receiverCallPattern = `
(call_expression
  function: (selector_expression
    operand: (identifier) @receiver
    field: (field_identifier) @method)) @call
`;
/**
 * Go 的"比较逻辑"不是调用点，而是 `if` 的**条件形态**（官方 Overview 范例
 * `if got != 1 { t.Errorf(...) }`）。`consequence` 只取 `if` 的**体**：条件里的调用
 * 不算断言点（`if t.Failed() { ... }` 不产生失败信号，官方把 `T.Failed` 定义为查询状态）。
 */
const comparisonIfPattern = `
(if_statement
  condition: [(binary_expression) (call_expression) (unary_expression)]
  consequence: (block) @guarded) @comparison
`;
const assertionMethods = new Set(["Error", "Errorf", "Fatal", "Fatalf", "Fail", "FailNow"]);
const skipMethods = new Set(["Skip", "Skipf", "SkipNow"]);
const controlFlowPattern = `[
  (if_statement) @full
  (expression_switch_statement) @full
  (type_switch_statement) @full
  (select_statement) @full
  (expression_case) @case
  (type_case) @case
  (communication_case) @case
  (default_case) @case
]`;
const nestedFunctionPattern = `[
  (func_literal) @nested
  (function_declaration) @nested
  (method_declaration) @nested
]`;

interface GoTestCandidate {
  readonly name: string;
  readonly receivers: ReadonlySet<string>;
  readonly startLine: number;
  readonly endLine: number;
  readonly startIndex?: number;
  readonly endIndex?: number;
}

const capture = (match: QueryMatch, name: string) => match.captures.find((item) => item.name === name);
/**
 * 测试名判据 = 官方措辞（[pkg.go.dev/testing](https://pkg.go.dev/testing) Overview）：
 * "any function of the form `func TestXxx(*testing.T)` where **Xxx does not start with a
 * lowercase letter**"。`^Test[A-Z]` 比官方更严，会漏掉合法的 `Test_foo` / `Test1`
 * （`_` 与数字都不是小写字母）；此处用负向断言表达，`Testify` 这类 `Test` + 小写字母的
 * 名字**不**算（官方 `go help testfunc` 对 `TestXxx`/`BenchmarkXxx`/`FuzzXxx` 用同一措辞，
 * 而 `Example` 走 R5/R6 的另一套命名规则，本 provider 未覆盖）。
 */
const isGoTestName = (name: string): boolean => /^Test(?:[^a-z]|$)/.test(name);
const hasTestingParameter = (parameters: string): boolean => /\*\s*(?:[A-Za-z_]\w*\.)?T\b/.test(parameters);
const testingReceivers = (parameters: string): ReadonlySet<string> => {
  const names = parameters.matchAll(/(?:^|[,\(])\s*([A-Za-z_]\w*)\s+\*\s*(?:[A-Za-z_]\w*\.)?T\b/g);
  return new Set([...names].map((match) => match[1]));
};
/**
 * 该调用是否被某个 `if` 条件形态的守卫体包含（第③层证据：条件比较的**决策点**）。
 * offset 为 0-based；缺 offset 即不可判定 ⇒ 不认为包含。
 */
const insideComparisonGuard = (call: QueryCapture, guards: readonly QueryCapture[]): boolean =>
  call.startIndex !== undefined && call.endIndex !== undefined && guards.some((guard) =>
    guard.startIndex !== undefined && guard.endIndex !== undefined
    && call.startIndex! >= guard.startIndex && call.endIndex! <= guard.endIndex);

const collectCandidates = (matches: readonly QueryMatch[]): readonly GoTestCandidate[] =>
  matches.flatMap((match) => {
    const name = capture(match, "name");
    const parameters = capture(match, "parameters");
    const body = capture(match, "body");
    if (!name || !parameters || !body || !isGoTestName(name.text) || !hasTestingParameter(parameters.text)) return [];
    return [{
      name: name.text,
      receivers: testingReceivers(parameters.text),
      startLine: body.startLine ?? 1,
      endLine: body.endLine ?? body.startLine ?? 1,
      startIndex: body.startIndex,
      endIndex: body.endIndex,
    }];
  });

/**
 * Go 的断言识别是**三层判据**，不是调用名匹配。
 *
 * 官方依据：Go **没有内建断言** —— "Go doesn't provide assertions"
 * （[Go FAQ — Why does Go not have assertions?](https://go.dev/doc/faq)）；失败信号由
 * `*testing.T` 上的方法调用产生（"use T.Error, T.Fail or related methods to signal failure"，
 * [pkg.go.dev/testing](https://pkg.go.dev/testing)），而真正的比较逻辑写在 `if` 的**条件**里
 * （官方 Overview 范例 `if got != 1 { t.Errorf(...) }`）。
 *
 * 三层 = ① 调用名 ∈ `Error/Errorf/Fatal/Fatalf/Fail/FailNow`；② 接收者 ∈ 该函数参数表解析出的
 * `*testing.T` 名集合（挡住"任意类型的 `Error()` 方法"）；③ `if` 条件形态（挡住"只看调用名 ⇒
 * 完全看不到比较逻辑"）。
 *
 * ③ 的**实现边界（不猜）**：tree-sitter 查询不暴露父节点，因此无法证明"这个 `t.Error*` 调用就在
 * 那个 `if` 的体内"。可行的闭合形状是：**`if` 条件里没有该测试接收者的失败调用 ⇒ 该 `if` 自身
 * 是一个比较断言点**（`if a != b { t.Errorf(...) }` 与裸 `t.Errorf(...)` 各计 1，不重复计数；
 * 而 `if t.Failed() { ... }` 被排除 —— 官方把 `T.Failed` 定义为查询状态，不产生失败信号）。
 *
 * 官方还要求接收者∈参数表**不可配置**（防止名字巧合变成断言），所以本 provider 只做静态事实，
 * 不替项目启用 `panic` 或 helper 委托判据（见内部语言形状调研 §1.4）。
 */
export const GO_TESTING_PROVIDER_ID = "go-testing";

/** Go's standard test functions have no universal assertion library, so this provider reports facts without a missing-assertion policy. */
export const goTestingProvider: TestFrameworkProvider = {
    id: GO_TESTING_PROVIDER_ID,
  label: "Go testing 标准库",
  supports: (file) => toPosixPath(file).endsWith("_test.go"),
  collect: async (file: string, parser: ParserService): Promise<TestProviderResult> => {
    const functions = await Effect.runPromise(parser.query(file, testFunctionPattern));
    const calls = await Effect.runPromise(parser.query(file, receiverCallPattern));
    const comparisonGuards = await Effect.runPromise(parser.query(file, comparisonIfPattern));
    const controlFlow = await Effect.runPromise(parser.query(file, controlFlowPattern));
    const nestedFunctions = await Effect.runPromise(parser.query(file, nestedFunctionPattern));
    const candidates = collectCandidates(functions);
    const tests: TestCaseMetric[] = candidates.map((test) => {
      const assertionCalls = calls.filter((match) => {
        const receiver = capture(match, "receiver")?.text;
        const method = capture(match, "method")?.text;
        return receiver !== undefined && test.receivers.has(receiver) && method !== undefined && assertionMethods.has(method)
          && capturesInTestBody(test, [match], nestedFunctions, "call").length > 0;
      });
      const ownedGuards = capturesInTestBody(test, comparisonGuards, nestedFunctions, "guarded");
      /**
       * 第三层证据：`if` 条件形态的**决策点**，且条件里没有该测试接收者的失败调用。
       * 已有失败调用的 `if` 由上面的 `assertionCalls` 计数（其调用落在守卫体内），此处不重复。
       */
      const comparisonAssertions = ownedGuards.filter((guard) =>
        !assertionCalls.some((match) => insideComparisonGuard(capture(match, "call")!, [guard]))).length;
      return {
        name: test.name,
        loc: Math.max(0, test.endLine - test.startLine + 1),
        assertionCount: assertionCalls.length + comparisonAssertions,
        mockCount: 0,
        statuses: [],
        testBodyControlFlow: controlFlowInTestBody(test, controlFlow, nestedFunctions),
      };
    });
    const findings: TestProviderResult["findings"] = candidates.flatMap((test) => calls.flatMap((match) => {
      const receiver = capture(match, "receiver")?.text;
      const method = capture(match, "method")?.text;
      const call = capture(match, "call");
      const belongsToTest = capturesInTestBody(test, [match], nestedFunctions, "call").length > 0;
      if (!receiver || !method || !call || !test.receivers.has(receiver) || !skipMethods.has(method) || !belongsToTest) return [];
      return [{
        ruleId: "go-testing.skip-call",
        kind: "unapproved_skip",
        file,
        testName: test.name,
        line: call.startLine,
        evidence: [`${receiver}.${method}() in recognised test body`],
        // A direct call is a reliable static fact, but conditional execution is a runtime question.
        confidence: "high" as const,
      }];
    }));
    return {
      tests,
      testCaseSpans: candidates.map(({ name, startLine, endLine }) => ({ name, startLine, endLine, statuses: [] })),
      findings,
    };
  },
};
