import { Effect } from "effect";
import type { QueryMatch, ParserService } from "../../port/ParserService";
import type { TestCaseMetric, TestFindingInput } from "../../domain/testGovernance";
import type { TestFrameworkProvider, TestProviderResult } from "../provider";
import { capturesInTestBody, controlFlowInTestBody } from "../controlFlow";

const methodPattern = `(method_declaration (modifiers) @modifiers name: (identifier) @name body: (block) @body) @method`;
const importPattern = `(import_declaration) @import`;
const callPattern = `(method_invocation name: (identifier) @name) @call`;
const controlFlowPattern = `[(if_statement) @full (switch_expression) @full (switch_label) @case]`;
const nestedFunctionPattern = `[(lambda_expression) @nested (method_declaration) @nested (constructor_declaration) @nested]`;
const assertionMethods = new Set(["assertEquals", "assertNotEquals", "assertTrue", "assertFalse", "assertNull", "assertNotNull", "assertSame", "assertNotSame", "assertThrows", "assertThat", "assertArrayEquals", "assertDoesNotThrow", "assertIterableEquals", "fail"]);

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
const normalized = (file: string): string => file.replace(/\\/g, "/");
const isTestFile = (file: string): boolean => /(^|\/)src\/test\/java\//i.test(normalized(file)) || /(?:Test|Tests|IT)\.java$/i.test(file);
const annotationNames = (modifiers: string): readonly string[] => [...modifiers.matchAll(/@(?:[\w.]+\.)?([A-Za-z_]\w*)\b/g)].map((match) => match[1]);
const hasJunitImport = (imports: readonly QueryMatch[]): boolean => imports.some((entry) => /\b(?:static\s+)?org\.junit(?:\.|;)/.test(capture(entry, "import")?.text ?? ""));

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

/** JUnit 4/5 standard syntax only. Custom annotations, parameterized tests, Mockito and framework lifecycle remain outside this static provider. */
export const junitProvider: TestFrameworkProvider = {
  id: JUNIT_PROVIDER_ID,
  supports: isTestFile,
  collect: async (file: string, parser: ParserService): Promise<TestProviderResult> => {
    const [methods, imports, calls, controlFlow, nested] = await Promise.all([
      Effect.runPromise(parser.query(file, methodPattern)), Effect.runPromise(parser.query(file, importPattern)),
      Effect.runPromise(parser.query(file, callPattern)), Effect.runPromise(parser.query(file, controlFlowPattern)),
      Effect.runPromise(parser.query(file, nestedFunctionPattern)),
    ]);
    const tests = candidates(methods, hasJunitImport(imports));
    const metrics: TestCaseMetric[] = tests.map((test) => ({
      name: test.name, loc: Math.max(0, test.endLine - test.startLine + 1),
      assertionCount: capturesInTestBody(test, calls, nested, "name").filter((call) => assertionMethods.has(call.text)).length,
      mockCount: 0, statuses: test.statuses, testBodyControlFlow: controlFlowInTestBody(test, controlFlow, nested),
    }));
    const findings: TestFindingInput[] = tests.filter((test) => test.statuses.includes("ignored")).map((test) => ({
      ruleId: "java-junit.disabled-test", kind: "unapproved_skip", file, testName: test.name, line: test.line,
      evidence: ["@Disabled/@Ignore on recognised JUnit @Test method"], confidence: "high" as const,
    }));
    for (const test of metrics.filter((test) => test.assertionCount === 0 && !test.statuses.includes("ignored"))) findings.push({
      ruleId: "java-junit.missing-known-assertion", kind: "missing_assertion", file, testName: test.name,
      evidence: ["no recognised JUnit assertion in test body"], confidence: "low" as const,
    });
    return {
      tests: metrics,
      testCaseSpans: tests.map(({ name, startLine, endLine, statuses }) => ({ name, startLine, endLine, statuses })),
      findings,
    };
  },
};
