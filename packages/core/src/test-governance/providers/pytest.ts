import { Effect } from "effect";
import type { QueryMatch, ParserService } from "../../port/ParserService";
import type { TestCaseMetric, TestFindingInput } from "../../domain/testGovernance";
import type { TestFrameworkProvider, TestProviderContext, TestProviderResult } from "../provider";
import { capturesInTestBody, controlFlowInTestBody } from "../controlFlow";
import { assertionWrapperScope, namedFunctionsFrom } from "../assertionScope";
import { toPosixPath } from "../../infra/paths";

const functionPattern = `(function_definition name: (identifier) @name body: (block) @body) @function`;
const decoratedFunctionPattern = `(decorated_definition (decorator) @decorator (function_definition name: (identifier) @name body: (block) @body) @function) @definition`;
const assertPattern = `(assert_statement) @assertion`;
const memberCallPattern = `(call function: (attribute object: (identifier) @object attribute: (identifier) @method)) @call`;
const identifierCallPattern = `(call function: (identifier) @callee) @call`;
const classPattern = `(class_definition name: (identifier) @name body: (block) @body) @class`;
const controlFlowPattern = `[(if_statement) @full (for_statement) @full (while_statement) @full (match_statement) @full (case_clause) @case]`;
const nestedFunctionPattern = `[(function_definition) @nested (lambda) @nested]`;
const assertionMockConstructors = new Set(["Mock", "MagicMock", "AsyncMock"]);

interface PytestCandidate {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly line: number;
  readonly startIndex?: number;
  readonly endIndex?: number;
  readonly functionStart?: number;
  readonly functionEnd?: number;
  readonly statuses: readonly string[];
}

interface PytestClass {
  readonly name: string;
  readonly startIndex?: number;
  readonly endIndex?: number;
}

interface DecoratorFacts {
  readonly statuses: readonly string[];
  readonly fixture: boolean;
}

const capture = (match: QueryMatch, name: string) => match.captures.find((item) => item.name === name);
const normalized = (file: string) => toPosixPath(file);
const isPytestFile = (file: string) => /(^|\/)(?:tests?|__tests__)\/.*\.py$/i.test(normalized(file)) || /(?:^|\/)test_[^/]+\.py$/i.test(normalized(file)) || /_test\.py$/i.test(normalized(file));
const isTestName = (name: string) => /^test_/.test(name);
const isInside = (inner: PytestCandidate, outer: PytestCandidate) =>
  inner.functionStart !== undefined && inner.functionEnd !== undefined && outer.startIndex !== undefined && outer.endIndex !== undefined
  && inner.functionStart >= outer.startIndex && inner.functionEnd <= outer.endIndex;

const decoratorFacts = (decorators: readonly string[]): DecoratorFacts => {
  const normalizedDecorators = decorators.map((decorator) => decorator.replace(/\s/g, ""));
  return {
    statuses: normalizedDecorators.some((decorator) => decorator.startsWith("@pytest.mark.skip") || decorator.startsWith("@pytest.mark.skipif"))
      ? ["skipped"]
      : normalizedDecorators.some((decorator) => decorator.startsWith("@pytest.mark.xfail")) ? ["xfail"] : [],
    fixture: normalizedDecorators.some((decorator) => decorator.startsWith("@pytest.fixture")),
  };
};

const collectCandidates = (
  functions: readonly QueryMatch[], decorated: readonly QueryMatch[], classes: readonly QueryMatch[],
): readonly PytestCandidate[] => {
  const decoratorByStart = new Map<number, DecoratorFacts>();
  for (const match of decorated) {
    const fn = capture(match, "function");
    if (fn?.startIndex === undefined) continue;
    decoratorByStart.set(fn.startIndex, decoratorFacts(match.captures.filter((item) => item.name === "decorator").map((item) => item.text)));
  }
  const classScopes: readonly PytestClass[] = classes.flatMap((match) => {
    const name = capture(match, "name");
    const body = capture(match, "body");
    return name && body ? [{ name: name.text, startIndex: body.startIndex, endIndex: body.endIndex }] : [];
  });
  const all = functions.flatMap((match) => {
    const name = capture(match, "name");
    const body = capture(match, "body");
    const fn = capture(match, "function");
    if (!name || !body || !fn || !isTestName(name.text)) return [];
    const decorators = decoratorByStart.get(fn.startIndex ?? -1);
    const parentClass = classScopes.find((scope) => fn.startIndex !== undefined && scope.startIndex !== undefined && scope.endIndex !== undefined
      && fn.startIndex >= scope.startIndex && fn.startIndex <= scope.endIndex);
    if (decorators?.fixture || (parentClass !== undefined && !/^Test/.test(parentClass.name))) return [];
    return [{
      name: name.text, startLine: body.startLine ?? 1, endLine: body.endLine ?? body.startLine ?? 1, line: name.startLine ?? 1,
      startIndex: body.startIndex, endIndex: body.endIndex, functionStart: fn.startIndex, functionEnd: fn.endIndex,
      statuses: decorators?.statuses ?? [],
    } satisfies PytestCandidate];
  });
  return all.filter((candidate) => !all.some((outer) => outer !== candidate && isInside(candidate, outer)));
};

export const PYTEST_PROVIDER_ID = "python-pytest";

/** Standard pytest naming and direct pytest APIs only; aliases, plugins and dynamic marks remain unavailable. */
export const pytestProvider: TestFrameworkProvider = {
    id: PYTEST_PROVIDER_ID,
  label: "pytest（Python）",
  supports: isPytestFile,
  collect: async (file: string, parser: ParserService, context?: TestProviderContext): Promise<TestProviderResult> => {
    const [functions, decorated, classes, assertions, memberCalls, identifierCalls, controlFlow, nested] = await Promise.all([
      Effect.runPromise(parser.query(file, functionPattern)), Effect.runPromise(parser.query(file, decoratedFunctionPattern)),
      Effect.runPromise(parser.query(file, classPattern)),
      Effect.runPromise(parser.query(file, assertPattern)), Effect.runPromise(parser.query(file, memberCallPattern)),
      Effect.runPromise(parser.query(file, identifierCallPattern)), Effect.runPromise(parser.query(file, controlFlowPattern)),
      Effect.runPromise(parser.query(file, nestedFunctionPattern)),
    ]);
    const tests = collectCandidates(functions, decorated, classes);
    // 语法级断言作用域（校准 2026-08-12）：文件级定义、体内含 assert 语句的
    // 函数视为断言包装（validate_created 等，不依赖命名前缀）。嵌套在测试体内的
    // 函数（嵌套 helper/嵌套测试）不计——其断言已由 belongs 的 nested 排除逻辑处理。
    const testNames = new Set(tests.map((test) => test.name));
    const fileLevelFunctions = namedFunctionsFrom([...functions, ...decorated].map((match) => ({
      name: capture(match, "name")?.text,
      bodyStart: capture(match, "body")?.startLine,
      bodyEnd: capture(match, "body")?.endLine,
    }))).filter((fn) => {
      if (testNames.has(fn.name)) return false;
      // 排除嵌套在任何测试候选体内的函数
      return !tests.some((test) => fn.bodyStart >= test.startLine && fn.bodyStart <= test.endLine);
    });
    const wrapperCallees = assertionWrapperScope(
      fileLevelFunctions,
      assertions.map((match) => capture(match, "assertion")?.startLine ?? -1),
    );
    const belongs = (test: PytestCandidate, match: QueryMatch, name: string) => capturesInTestBody(test, [match], nested, name).length > 0;
    const hasSkipCall = (test: PytestCandidate) => memberCalls.some((match) =>
      capture(match, "object")?.text === "pytest" && capture(match, "method")?.text === "skip" && belongs(test, match, "call"));
    const metrics: TestCaseMetric[] = tests.map((test) => ({
      name: test.name, loc: Math.max(0, test.endLine - test.startLine + 1), statuses: test.statuses,
      assertionCount: assertions.filter((match) => belongs(test, match, "assertion")).length
        + memberCalls.filter((match) => capture(match, "object")?.text === "pytest" && capture(match, "method")?.text === "raises" && belongs(test, match, "call")).length
        + identifierCalls.filter((match) => {
          const callee = capture(match, "callee")?.text ?? "";
          return (wrapperCallees.isAssertionCall(callee) || context?.isCrossFileWrapperCall(callee) === true) && belongs(test, match, "call");
        }).length,
      mockCount: memberCalls.filter((match) => ["monkeypatch", "mock"].includes(capture(match, "object")?.text ?? "")
        && ["setattr", "setitem", "patch"].includes(capture(match, "method")?.text ?? "") && belongs(test, match, "call")).length
        + identifierCalls.filter((match) => assertionMockConstructors.has(capture(match, "callee")?.text ?? "") && belongs(test, match, "call")).length,
      testBodyControlFlow: controlFlowInTestBody(test, controlFlow, nested),
    }));
    const findings: TestFindingInput[] = [];
    for (const test of tests.filter((test) => test.statuses.includes("skipped"))) findings.push({
      ruleId: "python-pytest.skip-marker", kind: "unapproved_skip", file, testName: test.name, line: test.line,
      evidence: ["@pytest.mark.skip/skipif on recognised test"], confidence: "high",
    });
    for (const test of tests) for (const match of memberCalls) {
      if (capture(match, "object")?.text !== "pytest" || capture(match, "method")?.text !== "skip" || !belongs(test, match, "call")) continue;
      findings.push({
        ruleId: "python-pytest.skip-call", kind: "unapproved_skip", file, testName: test.name, line: capture(match, "call")?.startLine,
        evidence: ["pytest.skip() in recognised test body"], confidence: "high",
      });
    }
    for (const [index, test] of metrics.entries()) {
      const candidate = tests[index]!;
      if (test.assertionCount !== 0 || test.statuses.includes("skipped") || hasSkipCall(candidate)) continue;
      findings.push({
        ruleId: "python-pytest.missing-known-assertion", kind: "missing_assertion", file, testName: test.name,
        evidence: ["no recognised assert statement or pytest.raises() in test body"], confidence: "low",
      });
    }
    return {
      tests: metrics,
      testCaseSpans: tests.map(({ name, startLine, endLine, statuses }) => ({ name, startLine, endLine, statuses })),
      findings,
    };
  },
};
