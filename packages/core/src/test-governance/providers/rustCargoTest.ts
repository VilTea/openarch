import { Effect } from "effect";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { QueryMatch, ParserService } from "../../port/ParserService";
import type { TestCaseMetric, TestFindingInput } from "../../domain/testGovernance";
import type { TestFrameworkProvider, TestProviderResult } from "../provider";
import { capturesInTestBody, controlFlowInTestBody } from "../controlFlow";
import { toPosixPath } from "../../infra/paths";

const functionPattern = `(function_item name: (identifier) @name body: (block) @body) @function`;
const attributePattern = `(attribute_item) @attribute`;
const macroPattern = `(macro_invocation macro: (identifier) @macro) @call`;
const callPattern = `[(call_expression function: (identifier) @callee) (call_expression function: (scoped_identifier name: (identifier) @callee)) (call_expression function: (generic_function function: (identifier) @callee))] @call`;
const controlFlowPattern = `[(if_expression) @full (match_expression) @full (match_arm) @case]`;
const nestedFunctionPattern = `[(closure_expression) @nested (function_item) @nested]`;
/**
 * 断言宏族（唯一权威）。
 *
 * `assert_matches!` / `debug_assert_matches!`（2026-09-27 补齐，`整改变更说明` §6.2 #3 ③）：
 * 官方把它们与 `assert!`/`assert_eq!` 并列，并明确指出在"检查值是否符合某个模式"时
 * 通常优于手写 `match` + `panic!`（依据与稳定版本引用见
 * 内部语言形状调研）。此前它们不在名单里 ⇒ 只写
 * `assert_matches!(…)` 的用例 `assertionCount` 记 0。
 * **`matches!` 刻意不收**：它是返回 `bool` 的表达式宏，本身不产生失败信号（`assert!(matches!(…))`
 * 由 `assert` 计入），把它算作断言会把普通布尔计算误判成验证。
 */
const assertionMacros = new Set([
  "assert", "assert_eq", "assert_ne", "debug_assert", "debug_assert_eq", "debug_assert_ne",
  "assert_matches", "debug_assert_matches",
]);

interface RustTestCandidate {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startIndex?: number;
  readonly endIndex?: number;
  readonly ignored: boolean;
}

const capture = (match: QueryMatch, name: string) => match.captures.find((item) => item.name === name);
const normal = (path: string) => toPosixPath(path);
const isIntegrationTest = (file: string): boolean => /(^|\/)tests\/.+\.rs$/i.test(normal(file));

/**
 * Cargo 测试目标的官方语义（2026-09-27，`整改变更说明` §6.2 #3 ④）。
 *
 * `#[test]` 是 libtest **唯一**的收集判据，但"一个文件是否属于测试目标"由 Cargo 决定：
 * - `tests/*.rs` 默认各自是集成测试目标；**`[package] autotests = false` 时不再自动**
 *   （此时只有 `[[test]]` 显式声明的目标会被构建）；
 * - `[[test]] path = "…"` 可以声明**任意路径**的目标；省略 `path` 时按官方约定回退到
 *   `tests/<name>.rs`；
 * - `[[test]] harness = false` 是**自定义 harness** 目标 ⇒ 不是 libtest，其 `#[test]` 不被收集。
 *
 * 读取失败语义（**只去重、不改事实**）：清单不存在或解析不了 ⇒ 回退到路径判据
 * （`tests` 目录下的 `.rs` 视为测试），并**不因此排除任何文件** —— 未解析清单的项目保持既有行为。
 * 记忆化按目录缓存（与 `GoModuleResolver.moduleCache`、`RustModuleResolver` 同构），
 * 因为 `supports(file)` 是逐文件调用的热路径。
 */
interface CargoTestTargets {
  readonly declared: ReadonlySet<string>;
  readonly autotests: boolean;
}

const manifestCache = new Map<string, CargoTestTargets | null>();

const readCargoTargets = (manifestDir: string, text: string): CargoTestTargets => {
  const doc = parseToml(text) as {
    package?: { autotests?: unknown };
    test?: readonly { readonly name?: unknown; readonly path?: unknown; readonly harness?: unknown }[];
  };
  const declared = new Set<string>();
  for (const target of doc.test ?? []) {
    if (target?.harness === false) continue;  // 自定义 harness：不是 libtest 目标
    const explicit = typeof target?.path === "string" ? target.path : undefined;
    const implicit = typeof target?.name === "string" ? join("tests", `${target.name}.rs`) : undefined;
    const relativePath = explicit ?? implicit;
    if (relativePath) declared.add(resolve(manifestDir, relativePath));
  }
  return { declared, autotests: doc.package?.autotests !== false };
};

/** 从文件所在目录向上找最近的 `Cargo.toml`；找不到返回 null（调用方回退路径判据）。 */
const cargoTargetsFor = (file: string): CargoTestTargets | null => {
  let current = resolve(dirname(resolve(file)));
  const visited: string[] = [];
  while (true) {
    if (manifestCache.has(current)) {
      const cached = manifestCache.get(current) ?? null;
      for (const dir of visited) manifestCache.set(dir, cached);
      return cached;
    }
    visited.push(current);
    const manifest = join(current, "Cargo.toml");
    if (existsSync(manifest)) {
      let targets: CargoTestTargets | null = null;
      try {
        targets = readCargoTargets(current, readFileSync(manifest, "utf8"));
      } catch {
        targets = null;  // 清单损坏 ⇒ 回退路径判据，不据此排除文件
      }
      for (const dir of visited) manifestCache.set(dir, targets);
      return targets;
    }
    const parent = dirname(current);
    if (parent === current) {
      for (const dir of visited) manifestCache.set(dir, null);
      return null;
    }
    current = parent;
  }
};

/** 该文件是否属于一个 libtest 测试目标（清单不可读时回退到路径判据）。 */
const supportsRustTestFile = (file: string): boolean => {
  const targets = cargoTargetsFor(file);
  if (!targets) return isIntegrationTest(file);
  if (targets.declared.has(resolve(file))) return true;
  if (!targets.autotests) return false;  // autotests=false ⇒ tests/ 下不再自动算测试目标
  return isIntegrationTest(file);
};
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
  label: "Rust #[test]（cargo test）",
  supports: supportsRustTestFile,
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
