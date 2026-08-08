import { Effect } from "effect";
import type { QueryMatch, ParserService } from "../../port/ParserService";
import type { TestCaseMetric, TestFindingInput } from "../../domain/testGovernance";
import type { TestFrameworkProvider, TestProviderResult } from "../provider";
import { capturesInTestBody, controlFlowInTestBody } from "../controlFlow";

const functionPattern = `(function_item name: (identifier) @name body: (block) @body) @function`;
const attributePattern = `(attribute_item) @attribute`;
const macroPattern = `(macro_invocation macro: (identifier) @macro) @call`;
const callPattern = `[(call_expression function: (identifier) @callee) (call_expression function: (scoped_identifier name: (identifier) @callee)) (call_expression function: (generic_function function: (identifier) @callee))] @call`;
const controlFlowPattern = `[(if_expression) @full (match_expression) @full (match_arm) @case]`;
const nestedFunctionPattern = `[(closure_expression) @nested (function_item) @nested]`;
const assertionMacros = new Set(["assert", "assert_eq", "assert_ne", "debug_assert", "debug_assert_eq", "debug_assert_ne"]);

interface RustTestCandidate {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startIndex?: number;
  readonly endIndex?: number;
  readonly ignored: boolean;
}

const capture = (match: QueryMatch, name: string) => match.captures.find((item) => item.name === name);
const normal = (path: string) => path.replace(/\\/g, "/");
const isIntegrationTest = (file: string): boolean => /(^|\/)tests\/.+\.rs$/i.test(normal(file));
const attributesBefore = (fn: QueryMatch, attributes: readonly QueryMatch[]) => {
  const start = capture(fn, "function")?.startLine ?? 0;
  const before = attributes.flatMap((match) => {
    const attribute = capture(match, "attribute");
    return attribute && (attribute.endLine ?? 0) < start && start - (attribute.endLine ?? 0) <= 4 ? [attribute] : [];
  });
  const testMarker = before.reduce((latest, attribute, index) => attribute.text.replace(/\s/g, "") === "#[test]" ? index : latest, -1);
  return testMarker >= 0 ? before.slice(testMarker) : [];
};

const candidates = (functions: readonly QueryMatch[], attributes: readonly QueryMatch[]): readonly RustTestCandidate[] =>
  functions.flatMap((fn) => {
    const name = capture(fn, "name");
    const body = capture(fn, "body");
    if (!name || !body) return [];
    const attrs = attributesBefore(fn, attributes).map((attribute) => attribute.text.replace(/\s/g, ""));
    if (!attrs.some((attribute) => attribute === "#[test]")) return [];
    return [{
      name: name.text, startLine: body.startLine ?? 1, endLine: body.endLine ?? body.startLine ?? 1,
      startIndex: body.startIndex, endIndex: body.endIndex,
      ignored: attrs.some((attribute) => attribute.startsWith("#[ignore")),
    }];
  });

export const RUST_TESTING_PROVIDER_ID = "rust-testing";

/** Standard Rust integration-test syntax only; Cargo execution belongs to the runner contract. */
export const rustCargoTestProvider: TestFrameworkProvider = {
  id: RUST_TESTING_PROVIDER_ID,
  supports: isIntegrationTest,
  collect: async (file: string, parser: ParserService): Promise<TestProviderResult> => {
    const [functions, attributes, macros, calls, controlFlow, nested] = await Promise.all([
      Effect.runPromise(parser.query(file, functionPattern)), Effect.runPromise(parser.query(file, attributePattern)),
      Effect.runPromise(parser.query(file, macroPattern)), Effect.runPromise(parser.query(file, callPattern)),
      Effect.runPromise(parser.query(file, controlFlowPattern)),
      Effect.runPromise(parser.query(file, nestedFunctionPattern)),
    ]);
    const tests = candidates(functions, attributes);
    // 测试体的直接调用集合（含断言宏与非断言调用）——用于缺失断言判定：
    // Rust idiom 把断言委托给共享辅助函数/宏（如 serde 的 assert_de_tokens），
    // 测试体有调用即视为存在验证意图，避免 missing_assertion 大规模误报（校准 2026-08-08）。
    const bodyCalls = (test: RustTestCandidate): number => macros.filter((match) =>
      capturesInTestBody(test, [match], nested, "call").length > 0).length
      + calls.filter((match) => capturesInTestBody(test, [match], nested, "call").length > 0).length;
    const metrics: TestCaseMetric[] = tests.map((test) => ({
      name: test.name, loc: Math.max(0, test.endLine - test.startLine + 1),
      assertionCount: macros.filter((match) => assertionMacros.has(capture(match, "macro")?.text ?? "")
        && capturesInTestBody(test, [match], nested, "call").length > 0).length,
      mockCount: 0, statuses: test.ignored ? ["ignored"] : [], testBodyControlFlow: controlFlowInTestBody(test, controlFlow, nested),
    }));
    const findings: TestFindingInput[] = tests.filter((test) => test.ignored).map((test) => ({
      ruleId: "rust-cargo-test.ignore-attribute", kind: "unapproved_skip", file, testName: test.name,
      evidence: ["#[ignore] on recognised #[test] function"], confidence: "high" as const,
    }));
    for (const test of tests.filter((candidate) => !candidate.ignored)) {
      const metric = metrics.find((entry) => entry.name === test.name);
      // 有断言宏或委托调用 → 不报；仅完全空体（无任何调用）才算可疑缺失断言
      if (metric && metric.assertionCount === 0 && bodyCalls(test) === 0) findings.push({
        ruleId: "rust-cargo-test.missing-known-assertion", kind: "missing_assertion", file, testName: test.name,
        evidence: ["no assert macro or delegated call in test body"], confidence: "low" as const,
      });
    }
    return {
      tests: metrics,
      testCaseSpans: tests.map(({ name, startLine, endLine, ignored }) => ({ name, startLine, endLine, statuses: ignored ? ["ignored"] : [] })),
      findings,
    };
  },
};
