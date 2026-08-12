// Node.js node:test provider：AST 识别 test()/it()/describe() 与 assert.* 断言。
// 与 vitest provider 同源的 test() 识别（node:test 也使用 test/it），断言识别
// 针对 node:assert 模块（assert.equal/strictEqual/deepStrictEqual/ok/throws/...）。
import { Effect } from "effect";
import type { QueryCapture, QueryMatch, ParserService } from "../../port/ParserService";
import type { TestCaseMetric, TestFindingInput } from "../../domain/testGovernance";
import type { TestFrameworkProvider, TestProviderResult } from "../provider";
import { capturesInTestBody, controlFlowInTestBody } from "../controlFlow";
import { toPosixPath } from "../../infra/paths";

const directTestPattern = `
(call_expression
  function: (identifier) @callee
  arguments: (arguments
    (string) @name
    (arrow_function body: (statement_block) @body))) @call
`;
const memberTestPattern = `
(call_expression
  function: (member_expression
    object: (identifier) @callee
    property: (property_identifier) @modifier)
  arguments: (arguments
    (string) @name
    (arrow_function body: (statement_block) @body))) @call
`;
const identifierCallPattern = `(call_expression function: (identifier) @callee) @call`;
const memberCallPattern = `(call_expression function: (member_expression object: (identifier) @object property: (property_identifier) @method)) @call`;
const namedImportPattern = `(import_statement (import_clause (named_imports (import_specifier name: (identifier) @symbol))) source: (string) @source)`;
const controlFlowPattern = `[
  (if_statement) @full
  (switch_statement) @full
  (switch_case) @case
  (switch_default) @case
]`;
const nestedFunctionPattern = `[
  (arrow_function) @nested
  (function_declaration) @nested
  (method_definition) @nested
]`;

/** node:assert 断言方法（assert.strictEqual / assert.equal / assert.deepStrictEqual / assert.ok / ...）。 */
const ASSERT_METHODS = [
  "equal", "notEqual", "strictEqual", "notStrictEqual", "deepEqual", "notDeepEqual",
  "deepStrictEqual", "notDeepStrictEqual", "ok", "notOk", "fail", "throws", "rejects",
  "doesNotThrow", "doesNotReject", "match", "doesNotMatch", "ifError", "property",
];

interface TestCandidate {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly line: number;
  readonly statuses: readonly string[];
  readonly startIndex?: number;
  readonly endIndex?: number;
}

const capture = (match: QueryMatch, name: string): QueryCapture | undefined => match.captures.find((item) => item.name === name);
const cleanName = (text: string): string => text.replace(/^['"]|['"]$/g, "");
const within = (line: number | undefined, test: TestCandidate): boolean => line !== undefined && line >= test.startLine && line <= test.endLine;

const collectCandidates = (matches: readonly QueryMatch[], qualified: boolean): TestCandidate[] =>
  matches.flatMap((match) => {
    const callee = capture(match, "callee")?.text;
    const modifier = qualified ? capture(match, "modifier")?.text : undefined;
    const name = capture(match, "name");
    const body = capture(match, "body");
    if (!callee || !name || !body || !["it", "test"].includes(callee)) return [];
    const statuses = modifier && ["only", "skip"].includes(modifier) ? [modifier] : [];
    return [{
      name: cleanName(name.text), startLine: body.startLine ?? 1, endLine: body.endLine ?? body.startLine ?? 1,
      line: name.startLine ?? 1, statuses, startIndex: body.startIndex, endIndex: body.endIndex,
    }];
  });

const findMemberCalls = (matches: readonly QueryMatch[], objects: readonly string[], methods: readonly string[]): number[] =>
  matches.flatMap((match) => {
    const object = capture(match, "object")?.text;
    const method = capture(match, "method")?.text;
    const call = capture(match, "call");
    return object && method && call && objects.includes(object) && methods.includes(method) && call.startLine !== undefined
      ? [call.startLine] : [];
  });

export const NODE_TEST_PROVIDER_ID = "node-test";

export const nodeTestProvider: TestFrameworkProvider = {
  id: NODE_TEST_PROVIDER_ID,
  supports: (file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(toPosixPath(file)) || file.includes("/__tests__/"),
  collect: async (file: string, parser: ParserService): Promise<TestProviderResult> => {
    // ParserService 的 WASM parser 是共享实例；顺序 query 避免首次初始化及 tree 访问竞态。
    const direct = await Effect.runPromise(parser.query(file, directTestPattern));
    const member = await Effect.runPromise(parser.query(file, memberTestPattern));
    const calls = await Effect.runPromise(parser.query(file, identifierCallPattern));
    const memberCalls = await Effect.runPromise(parser.query(file, memberCallPattern));
    const controlFlow = await Effect.runPromise(parser.query(file, controlFlowPattern));
    const nestedFunctions = await Effect.runPromise(parser.query(file, nestedFunctionPattern));
    const namedImports = await Effect.runPromise(parser.query(file, namedImportPattern));
    const candidates = [...collectCandidates(direct, false), ...collectCandidates(member, true)]
      .filter((candidate, index, all) => all.findIndex((other) => other.startLine === candidate.startLine && other.name === candidate.name) === index)
      .sort((a, b) => a.startLine - b.startLine);
    // node:test 断言：assert.* 成员调用（assert.strictEqual 等）与独立 assert（assert(cond) 函数形式）。
    const assertionLines = [
      ...findMemberCalls(memberCalls, ["assert"], ASSERT_METHODS),
      ...calls.flatMap((match) => capture(match, "callee")?.text === "assert" && capture(match, "call")?.startLine !== undefined
        ? [capture(match, "call")!.startLine!] : []),
    ];
    const mockLines = findMemberCalls(memberCalls, ["mock", "vi"], ["mock", "spyOn", "fn"]);
    const imports = namedImports.flatMap((match) => {
      const source = capture(match, "source");
      const symbol = capture(match, "symbol");
      return source && symbol ? [{ source: cleanName(source.text), symbol: symbol.text }] : [];
    });

    const tests: TestCaseMetric[] = candidates.map((candidate) => ({
      name: candidate.name,
      loc: Math.max(0, candidate.endLine - candidate.startLine + 1),
      assertionCount: assertionLines.filter((line) => within(line, candidate)).length,
      mockCount: mockLines.filter((line) => within(line, candidate)).length,
      statuses: candidate.statuses,
      testBodyControlFlow: controlFlowInTestBody(candidate, controlFlow, nestedFunctions),
    }));
    const findings: TestFindingInput[] = [];
    for (const candidate of candidates) {
      if (candidate.statuses.includes("only")) findings.push({
        ruleId: "node-test.focused-test", kind: "focused_test", file, testName: candidate.name, line: candidate.line,
        evidence: ["it.only/test.only"], confidence: "confirmed",
      });
      if (candidate.statuses.includes("skip")) findings.push({
        ruleId: "node-test.skipped-test", kind: "unapproved_skip", file, testName: candidate.name, line: candidate.line,
        evidence: ["it.skip/test.skip"], confidence: "confirmed",
      });
    }
    for (const match of member) {
      const callee = capture(match, "callee")?.text;
      const modifier = capture(match, "modifier")?.text;
      const name = capture(match, "name");
      if (callee !== "describe" || !name || !["only", "skip"].includes(modifier ?? "")) continue;
      findings.push({
        ruleId: modifier === "only" ? "node-test.focused-suite" : "node-test.skipped-suite",
        kind: modifier === "only" ? "focused_test" : "unapproved_skip",
        file, testName: cleanName(name.text), line: name.startLine,
        evidence: [`describe.${modifier}`], confidence: "confirmed",
      });
    }
    for (const test of tests.filter((test) => test.assertionCount === 0 && !test.statuses.includes("skip"))) findings.push({
      ruleId: "node-test.missing-known-assertion", kind: "missing_assertion", file, testName: test.name,
      evidence: ["no recognised assert.* call in test body"], confidence: "low",
    });
    const symbolCallEvidence = candidates.flatMap((candidate) => {
      const called = new Set(capturesInTestBody(candidate, calls, nestedFunctions, "callee").map((item) => item.text));
      return imports.filter((item) => called.has(item.symbol)).map((item) => ({ testName: candidate.name, ...item }));
    });
    return {
      tests,
      testCaseSpans: candidates.map(({ name, startLine, endLine, statuses }) => ({ name, startLine, endLine, statuses })),
      findings,
      symbolCallEvidence,
    };
  },
};
