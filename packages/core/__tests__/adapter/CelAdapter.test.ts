import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { RuleService, RuleCompileError } from "../../src/port/RuleService";
import { CelAdapterLive, tokenize } from "../../src/adapter/rule/CelAdapter";

const compile = (name: string, expr: string) =>
  Effect.gen(function* () {
    const svc = yield* RuleService;
    return yield* svc.compile(name, expr);
  }).pipe(Effect.provide(CelAdapterLive));

// ---------------------------------------------------------------------------
// 词法性能替换的对拍（内部审计记录 §4.3）
// ---------------------------------------------------------------------------

type Token = ReturnType<typeof tokenize>[number];

/**
 * **参照实现**：逐字复制整改前的逐字符正则 `tokenize`（0.1.5 的 CelAdapter.ts:20-59）。
 *
 * 它只存在于测试里，作为"改前/改后 token 序列逐字相等"的 oracle。生产代码中这门语言
 * 仍然只有 `tokenize` 一个词法入口（认知点原则）——这里不是第二套解析，是过期实现快照。
 * 若将来 CEL 子集语法本身要演进，应当同时更新本快照并重新解释差异，而不是默默删除它。
 */
const tokenizeBefore = (src: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i]!)) { i++; continue; }
    if ("()".includes(src[i]!)) { tokens.push({ type: "paren", value: src[i] as "(" | ")" }); i++; continue; }
    if (/[&|]{2}/.test(src.slice(i, i + 2))) {
      tokens.push({ type: "op", value: src.slice(i, i + 2) }); i += 2; continue;
    }
    if (/[><=!]=?/.test(src.slice(i, i + 2)) || /[><=!]/.test(src[i]!)) {
      let op = src[i]!;
      if (src[i + 1] === "=") { op += "="; i++; }
      i++;
      tokens.push({ type: "op", value: op });
      continue;
    }
    if (src[i] === '"' || src[i] === "'") {
      const quote = src[i]!; i++;
      let s = "";
      while (i < src.length && src[i] !== quote) { s += src[i]; i++; }
      i++; // skip closing quote
      tokens.push({ type: "string", value: s });
      continue;
    }
    if (/[0-9.]/.test(src[i]!)) {
      let num = "";
      while (i < src.length && /[0-9.]/.test(src[i]!)) { num += src[i]; i++; }
      tokens.push({ type: "number", value: parseFloat(num) });
      continue;
    }
    if (/[a-zA-Z_]/.test(src[i]!)) {
      let id = "";
      while (i < src.length && /[a-zA-Z0-9_]/.test(src[i]!)) { id += src[i]; i++; }
      tokens.push({ type: "ident", value: id });
      continue;
    }
    throw new RuleCompileError(src, `Unexpected character: '${src[i]}'`);
  }
  return tokens;
};

/** 把"token 序列"或"抛错信息"压成可逐字比较的字符串——两条通道都必须一致。 */
const outcome = (run: (src: string) => Token[], src: string): string => {
  try {
    return JSON.stringify(run(src));
  } catch (error) {
    return `THROW:${(error as Error).message}`;
  }
};

const expectSameOutcome = (src: string): void => {
  expect(outcome(tokenize, src)).toBe(outcome(tokenizeBefore, src));
};

/** 真实条件语料：`.openarch/config.yml` 的 `structural_policies` 条件（2026-09-25 快照）。 */
const realConditions: readonly string[] = [
  "max_func_branch > 25",
  'path_class == "domain" && max_func_branch > 5',
  'path_class == "application" && max_func_branch > 15',
  'path_class == "parser" && max_func_branch > 20',
  'path_class == "default" && max_func_branch > 8',
  'path_class == "domain" && crl_local > 0.55',
  'path_class == "application" && crl_local > 0.65',
  'path_class == "parser" && crl_local > 0.70',
  'path_class == "adapter" && crl_local > 0.55',
  'path_class == "contract" && crl_local > 0.55 && exposure > 0.6',
  'path_class != "contract" && crl_local > 0.45 && exposure > 0.6',
  "max_func_branch > 5",
  "weighted_branch_total > 12 || top_level_branch > 8",
  'path_class == "domain" && (max_func_branch > 5 || crl_local > 0.5)',
];

/** 合成语料：覆盖每一种 token 形态、每种空白、每个运算符组合与全部已知边界。 */
const syntheticConditions: readonly string[] = [
  "", " ", "\t", "\n", "\r\n", "\v", "\f", "\u00a0", "\u1680", "\u2003", "\u2028", "\u2029",
  "\u202f", "\u205f", "\u3000", "\ufeff", " \t\n\r\v\f\u00a0\u3000 ",
  // 空白类之外的控制/不可见字符必须逐字同错（\u200b 零宽空格、\u180e 在 ES2018 后不是空白）
  "\u200b", "\u180e", "\u0000", "§", "中", "@", "$", "\\", "`", "%", "^", "~", "?", ",", ";", ":", "[", "]", "{", "}",
  // 数字（含审计 §6.1 D9 记录的 `[0-9.]` 既有语义）
  "0", "5", "007", "1.2", "1.2.3", "1.2.3.4", ".", "..", "...", ".5", "5.", "1..2", "1e5", "3.14.15",
  "max_func_branch > 1.2.3", "max_func_branch > .",
  // 字符串
  "'a'", '"a"', "''", '""', `'a"b'`, `"a'b"`, "'unclosed", '"unclosed', "'", '"',
  `'a\\'b'`, `"a\\"b"`, "'多字节字符串'", `"line\\nbreak"`,
  'path_class == "domain"', "path_class == 'domain'", 'path_class == "a" && language == \'b\'',
  // 比较运算符（含单字符结尾、`=?` 的组合形态）
  "a > 1", "a >= 1", "a < 1", "a <= 1", "a == 1", "a != 1", "a = 1", "a =< 1", "a => 1",
  "a === 1", "a !== 1", "a =! 1", ">", "<", "=", "!", ">=", "<=", "==", "!=", "=<", "=>", ">=<", "!==",
  // 逻辑运算符（含既有误收的 `|&`/`&|`）
  "a && b", "a || b", "a |& b", "a &| b", "a & b", "a | b", "&&", "||", "|&", "&|", "&", "|",
  "a &&& b", "a ||| b", "a &&|| b",
  // 括号与标识符
  "(", ")", "()", "(a)", "((a))", "(a > 1) && (b < 2)", "(a", "a)", "()()", "a()b",
  "a", "_", "__", "a_b1", "A1", "_1", "1a", "a1.b2", "max_func_branch", "path_class",
  // 代理对（逐字符扫描必须与正则同样只看到单个 UTF-16 码元）
  "😀", "a😀b", "\ud83d", "\ude00", "path_class == \"😀\"",
  // 混合形态与首尾空白
  "  max_func_branch > 25  ",
  "\n\tpath_class == \"domain\"\r\n  && crl_local > 0.55\n",
];

describe("CelAdapter tokenizer（charCode 单遍扫描 = 逐字符正则的等价替换）", () => {
  it("真实 CEL 条件：token 序列逐字相等", () => {
    // 带一条自证断言：语料非空（否则"全等"是空真）
    expect(realConditions.length).toBeGreaterThanOrEqual(14);
    for (const condition of realConditions) {
      expect(outcome(tokenize, condition)).toBe(outcome(tokenizeBefore, condition));
      // 真实条件必须能被词法接受（否则对拍退化成"两边都抛错"）
      expect(() => tokenize(condition)).not.toThrow();
    }
  });

  it("合成语料：逐字相等（token 序列或异常信息）", () => {
    expect(syntheticConditions.length).toBeGreaterThanOrEqual(120);
    const mismatches = syntheticConditions.filter((condition) => outcome(tokenize, condition) !== outcome(tokenizeBefore, condition));
    expect(mismatches).toEqual([]);
  });

  it("全部 BMP 单字符：判定与错误信息逐一相等", () => {
    const mismatches: string[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      const src = String.fromCharCode(code);
      if (outcome(tokenize, src) !== outcome(tokenizeBefore, src)) mismatches.push(code.toString(16));
    }
    expect(mismatches).toEqual([]);
  });

  it("运算符/引号/括号/空白的 2 字符组合：逐一相等", () => {
    const alphabet = [..."()[]&|><=!\"'`,._aZ09 \t\n\r", "\u00a0", "\u3000", "\u200b", "\u1680"];
    const mismatches: string[] = [];
    for (const first of alphabet) {
      for (const second of alphabet) {
        const src = first + second;
        if (outcome(tokenize, src) !== outcome(tokenizeBefore, src)) mismatches.push(JSON.stringify(src));
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("长条件（多子句流式扫描）：token 序列逐字相等", () => {
    const clause = (index: number): string =>
      `path_class == "domain" && max_func_branch > ${(index * 7) % 97}.${index % 10} || nesting_depth <= ${index % 13}`;
    const long = Array.from({ length: 400 }, (_, index) => clause(index)).join(" && ");
    expect(long.length).toBeGreaterThan(20_000);
    expect(JSON.stringify(tokenize(long))).toBe(JSON.stringify(tokenizeBefore(long)));
  });

  it("既有语义被刻意保留：`1.2.3` → 1.2、孤立 `.` → NaN、`|&` 照抄原文", () => {
    // 审计 §6.1 D9：这两条是既有特性（另行立项），性能替换不得"顺手修正"。
    expect(tokenize("max_func_branch > 1.2.3")).toEqual([
      { type: "ident", value: "max_func_branch" },
      { type: "op", value: ">" },
      { type: "number", value: 1.2 },
    ]);
    const dot = tokenize("> .").find((token) => token.type === "number");
    expect(dot && Number.isNaN(dot.value as number)).toBe(true);
    // TD-10：`|&`/`&|` 仍被当作两字符 op 产出，由 parser 按 `&&`/`||` 白名单拒绝。
    expect(tokenize("a |& b")[1]).toEqual({ type: "op", value: "|&" });
    // 旧实现的比较分支用的是未锚定的 `/[><=!]=?/` 扫 2 字符窗口，于是 `a>5`（无空格）
    // 先产出 value 为 `a` 的 op token，被 parser 拒绝：`a > 5` 能编译而 `a>5` 不能。
    // 这是既有形态（同属 TD-10），本次替换逐字保留。
    expect(tokenize("a>5")[0]).toEqual({ type: "op", value: "a" });
    expect(tokenize("a > 5")).toEqual([
      { type: "ident", value: "a" },
      { type: "op", value: ">" },
      { type: "number", value: 5 },
    ]);
  });

  it("编译通道行为不变：`a>5` 仍拒绝、`a > 5` 仍编译，畸形数字仍按 parseFloat 语义求值", async () => {
    const rejected = await Effect.runPromise(compile("test", "a>5").pipe(Effect.either));
    expect(rejected._tag).toBe("Left");
    const spaced = await Effect.runPromise(compile("test", "x > 1.2.3"));
    expect(spaced.evaluate({ x: 1.25 })).toBe(true);   // 1.2.3 → 1.2
    expect(spaced.evaluate({ x: 1.15 })).toBe(false);
    const nan = await Effect.runPromise(compile("test", "x > ."));
    // NaN 参与比较恒为 false（既有行为，不在此修正）
    expect(nan.evaluate({ x: 100 })).toBe(false);
    expect(nan.evaluate({ x: -100 })).toBe(false);
  });
});

describe("CelAdapter (CEL-like expression evaluator)", () => {
  it("数字比较：branch_count > 5", async () => {
    const rule = await Effect.runPromise(compile("test", "branch_count > 5"));
    expect(rule.evaluate({ branch_count: 7 })).toBe(true);
    expect(rule.evaluate({ branch_count: 3 })).toBe(false);
    expect(rule.evaluate({ branch_count: 5 })).toBe(false); // > not >=
  });

  it("字符串相等：path_class == 'core'", async () => {
    const rule = await Effect.runPromise(compile("test", "path_class == 'core'"));
    expect(rule.evaluate({ path_class: "core" })).toBe(true);
    expect(rule.evaluate({ path_class: "default" })).toBe(false);
  });

  it("逻辑与：branch_count > 5 && nesting_depth > 3", async () => {
    const rule = await Effect.runPromise(compile("test", "branch_count > 5 && nesting_depth > 3"));
    expect(rule.evaluate({ branch_count: 7, nesting_depth: 4 })).toBe(true);
    expect(rule.evaluate({ branch_count: 7, nesting_depth: 2 })).toBe(false);
    expect(rule.evaluate({ branch_count: 3, nesting_depth: 4 })).toBe(false);
  });

  it("逻辑或：branch_count > 8 || nesting_depth > 5", async () => {
    const rule = await Effect.runPromise(compile("test", "branch_count > 8 || nesting_depth > 5"));
    expect(rule.evaluate({ branch_count: 10, nesting_depth: 1 })).toBe(true);
    expect(rule.evaluate({ branch_count: 3, nesting_depth: 6 })).toBe(true);
    expect(rule.evaluate({ branch_count: 3, nesting_depth: 1 })).toBe(false);
  });

  it("compile 失败 → RuleCompileError", async () => {
    const either = await Effect.runPromise(
      compile("test", "branch_count >>> 5").pipe(Effect.either)
    );
    expect(either._tag).toBe("Left");
    if (either._tag === "Left") {
      expect(either.left._tag).toBe("RuleCompileError");
    }
  });

  it("设计示例：核心层分支过多", async () => {
    // design v5.2 §8.1 rules_block 示例
    const rule = await Effect.runPromise(
      compile("核心层分支过多", 'path_class == "core" && branch_count > 5')
    );
    expect(rule.evaluate({ path_class: "core", branch_count: 7 })).toBe(true);
    expect(rule.evaluate({ path_class: "default", branch_count: 7 })).toBe(false);
    expect(rule.evaluate({ path_class: "core", branch_count: 3 })).toBe(false);
  });
});
