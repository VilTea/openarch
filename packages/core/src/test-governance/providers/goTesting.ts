import { Effect } from "effect";
import type { QueryMatch, ParserService } from "../../port/ParserService";
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
const isGoTestName = (name: string): boolean => /^Test[A-Z]/.test(name);
const hasTestingParameter = (parameters: string): boolean => /\*\s*(?:[A-Za-z_]\w*\.)?T\b/.test(parameters);
const testingReceivers = (parameters: string): ReadonlySet<string> => {
  const names = parameters.matchAll(/(?:^|[,\(])\s*([A-Za-z_]\w*)\s+\*\s*(?:[A-Za-z_]\w*\.)?T\b/g);
  return new Set([...names].map((match) => match[1]));
};
const within = (line: number | undefined, test: GoTestCandidate): boolean => line !== undefined && line >= test.startLine && line <= test.endLine;

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

export const GO_TESTING_PROVIDER_ID = "go-testing";

/** Go's standard test functions have no universal assertion library, so this provider reports facts without a missing-assertion policy. */
export const goTestingProvider: TestFrameworkProvider = {
    id: GO_TESTING_PROVIDER_ID,
  label: "Go testing 标准库",
  supports: (file) => toPosixPath(file).endsWith("_test.go"),
  collect: async (file: string, parser: ParserService): Promise<TestProviderResult> => {
    const functions = await Effect.runPromise(parser.query(file, testFunctionPattern));
    const calls = await Effect.runPromise(parser.query(file, receiverCallPattern));
    const controlFlow = await Effect.runPromise(parser.query(file, controlFlowPattern));
    const nestedFunctions = await Effect.runPromise(parser.query(file, nestedFunctionPattern));
    const candidates = collectCandidates(functions);
    const tests: TestCaseMetric[] = candidates.map((test) => ({
      name: test.name,
      loc: Math.max(0, test.endLine - test.startLine + 1),
      assertionCount: calls.filter((match) => {
        const receiver = capture(match, "receiver")?.text;
        const method = capture(match, "method")?.text;
        return receiver !== undefined && test.receivers.has(receiver) && method !== undefined && assertionMethods.has(method)
          && within(capture(match, "call")?.startLine, test);
      }).length,
      mockCount: 0,
      statuses: [],
      testBodyControlFlow: controlFlowInTestBody(test, controlFlow, nestedFunctions),
    }));
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
