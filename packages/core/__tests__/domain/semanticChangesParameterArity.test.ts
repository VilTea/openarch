import { describe, expect, it } from "vitest";
import { parameterArity } from "../../src/domain/semanticChanges";

/**
 * `parameterArity` 的**行为特征矩阵**（characterization test）。
 *
 * 这里的每个期望值都来自**改动前实现的真实输出**，不是"它应该输出什么"：
 * 探针脚本对同一份输入清单逐例打印 `JSON.stringify(输入) => String(输出)`，
 * 输出被原样抄进下表（探针已删除，命令与原始输出见交付报告）。
 * 因此这组测试是重构的等价性 oracle：任何一步拆分只要改变了任一例的输出就会失败。
 *
 * 覆盖的语义面：参数列表是最外层分组（第一个"可接受"的括号组，组内深度 1 处不得再出现 `(`）、
 * 引号/转义内的括号与逗号不参与分组、`()<>[]{}` 嵌套内的逗号不计、空/空白参数列表为 0、
 * 找不到可接受括号组时返回 `undefined`（**不猜**）。已知语义边界也一并钉住：
 * 计数是纯语法计数（`f(,)` → 2）、只取第一个分组（`f(a) and g(b)` → 1）。
 */

type ArityCase = readonly [signature: string, arity: number | undefined];

const CANONICAL_LISTS: readonly ArityCase[] = [
  ["fill(int a, int b)", 2],
  ["f()", 0],
  ["f( )", 0],
  ["f(a)", 1],
  ["f(a, b, c)", 3],
];

const NESTED_PARENS: readonly ArityCase[] = [
  // 第一个括号组内部出现第二层 `(` ⇒ 该组被拒绝，搜索从下一个 `(` 继续。
  ["f(g(a, b), c)", 2],
  ["f((a))", 1],
  ["f((a, b))", 2],
];

const GENERICS: readonly ArityCase[] = [
  ["f(Map<String, List<Integer>> m)", 1],
  ["f(List<? extends Number> l)", 1],
  ["f<T>(a, b)", 2],
];

const ARRAYS_AND_VARARGS: readonly ArityCase[] = [
  ["f(int[] a, String... b)", 2],
];

const QUOTES_AND_ESCAPES: readonly ArityCase[] = [
  ["f(String s)", 1],
  ['f("a,(b")', 1],
  [`f('a', "b)c")`, 2],
  ['f("a\\" ,b")', 1],
  ["f('\\'')", 1],
  // 引号未闭合 ⇒ 之后的 `)` 永远在引号里 ⇒ 没有可接受的组 ⇒ undefined。
  ['f("unclosed, a)', undefined],
];

const ARBITRARY_EXPRESSIONS: readonly ArityCase[] = [
  // 调用表达式同样被当成"参数列表"：启发式无法区分声明与调用。
  ["max(1, 2).size", 2],
  ["new Foo(a, b)", 2],
  ["if (a > 0)", 1],
  ["a = f(1)", 1],
  ["f(a) and g(b)", 1],
  ["(a, b)", 2],
  ["foo", undefined],
];

const MALFORMED_OR_EMPTY: readonly ArityCase[] = [
  ["f(a, b", undefined],
  ["f)a, b(", undefined],
  ["f(a, (b)", 1],
  ["", undefined],
  ["   ", undefined],
];

const UNICODE_IDENTIFIERS: readonly ArityCase[] = [
  ["f(变量 一, 二)", 2],
];

const SYNTACTIC_COUNTING_LIMITS: readonly ArityCase[] = [
  // 纯逗号计数：不做空参数校验，也不做参数语法校验。
  ["f(,)", 2],
];

const CANDIDATE_SELECTION_LIMITS: readonly ArityCase[] = [
  // 每个候选 `(` 都从它自己出发重新判定引号状态，所以字面量"内部"的 `(` 也可能成为参数表起点
  // （`q"(x)"` 的第一个候选是那个字面量里的 `(`）。这条正是 `findParameterList`
  // 必须"逐候选重扫"而不是"先做一次正确词法切分"的原因。
  ['q"(x)"', 1],
  // 第一个"可接受"的候选组先到先得：注解实参列表会赢过真正的参数表。
  // 这是当前实现的真实后果（不是理想语义），一并钉住，避免重构悄悄"修正"它。
  ['@SuppressWarnings("unchecked") void fill(int a, int b)', 1],
];

const GROUPS: readonly (readonly [name: string, cases: readonly ArityCase[]])[] = [
  ["a canonical parameter list", CANONICAL_LISTS],
  ["nested parens", NESTED_PARENS],
  ["generics", GENERICS],
  ["arrays and varargs", ARRAYS_AND_VARARGS],
  ["quotes and escapes", QUOTES_AND_ESCAPES],
  ["arbitrary expressions", ARBITRARY_EXPRESSIONS],
  ["malformed or empty input", MALFORMED_OR_EMPTY],
  ["unicode identifiers and whitespace", UNICODE_IDENTIFIERS],
  ["purely syntactic counting limits", SYNTACTIC_COUNTING_LIMITS],
  ["candidate selection limits (first acceptable group wins)", CANDIDATE_SELECTION_LIMITS],
];

describe("parameterArity behavior matrix (pinned from the pre-refactor implementation)", () => {
  for (const [name, cases] of GROUPS) {
    describe(name, () => {
      for (const [signature, arity] of cases) {
        it(`${JSON.stringify(signature)} => ${String(arity)}`, () => {
          expect(parameterArity(signature)).toBe(arity);
        });
      }
    });
  }

  it("pins every case at once so a drifted table cannot pass silently", () => {
    const matrix = GROUPS.flatMap(([, cases]) => cases);
    expect(matrix.map(([signature]) => parameterArity(signature))).toEqual(matrix.map(([, arity]) => arity));
    expect(matrix.length).toBe(34);
  });
});
