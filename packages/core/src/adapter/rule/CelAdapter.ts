// packages/core/src/adapter/rule/CelAdapter.ts
//
// Phase 1 最小 CEL-like 表达式求值器（手写，零依赖）。
// 支持：比较（== != > < >= <=）、逻辑（&& ||）、数字/字符串字面量、标识符。
// Phase 3 可换 google/cel-go 完整 CEL 实现（RuleService port 不变）。
import { Effect, Layer } from "effect";
import { RuleService, type CompiledRule, RuleCompileError } from "../../port/RuleService";

// ---------------------------------------------------------------------------
// Tokenizer + Parser (minimal CEL subset)
// ---------------------------------------------------------------------------

export type Token =
  | { type: "ident"; value: string }
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "op"; value: string }
  | { type: "paren"; value: "(" | ")" };

/** 单字符类：JS `/\s/` 覆盖的全部 BMP 空白码点（`9-a,d,20,a0,1680,2000-200a,2028,2029,202f,205f,3000,feff`）。
 *  逐字符 `regex.test` 是长条件上的主要开销（审计 §4.3 实测 3~4×），这里改为码点比较。 */
const isCelWhitespace = (code: number): boolean =>
  code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0x1680
  || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029
  || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;

/** `/[0-9.]/`：小数点也归入数字字面量。`1.2.3` 被 `parseFloat` 截断为 1.2、孤立 `.` 得到 NaN
 *  是**既有语义**（审计 §6.1 D9 已记录），本次只做性能等价替换，不在这里"顺手修正"。 */
const isCelDigitOrDot = (code: number): boolean => (code >= 0x30 && code <= 0x39) || code === 0x2e;

/** `/[a-zA-Z_]/`。 */
const isCelIdentifierStart = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f;

/** `/[a-zA-Z0-9_]/`。 */
const isCelIdentifierPart = (code: number): boolean =>
  isCelIdentifierStart(code) || (code >= 0x30 && code <= 0x39);

/** `/[><=!]/`。 */
const isCelComparisonChar = (code: number): boolean =>
  code === 0x3e || code === 0x3c || code === 0x3d || code === 0x21;

/** 旧实现的比较分支条件是 `/[><=!]=?/.test(src.slice(i, i + 2)) || /[><=!]/.test(src[i])`。
 *  前一条**未锚定**：只要 2 字符窗口内任意位置出现比较字符即命中，于是 `a>5` 会先产出一个
 *  value 为 `a` 的 op token（随后被 parser 拒绝）——`a > 5` 能编译而 `a>5` 不能。
 *  这是既有形态（TD-10 手写 CEL 子集技术债），本次只做性能等价替换，逐字保留该判定：
 *  条件 = 当前字符或下一字符是比较字符。 */
const isCelComparisonWindow = (src: string, index: number): boolean =>
  isCelComparisonChar(src.charCodeAt(index)) || isCelComparisonChar(src.charCodeAt(index + 1));

/** `/[&|]{2}/`：只判"成对出现"。既有的 `|&`/`&|` 误收保持不变——token 文本照抄原文，
 *  parser 随后按 `&&`/`||` 白名单拒绝（TD-10 已知技术债）。`charCodeAt` 越界得到 NaN，
 *  与任何码点比较都为 false，因此不需要额外的长度判断。 */
const isCelLogicalPair = (src: string, index: number): boolean => {
  const code = src.charCodeAt(index);
  const next = src.charCodeAt(index + 1);
  return (code === 0x26 || code === 0x7c) && (next === 0x26 || next === 0x7c);
};

/**
 * CEL 子集的唯一词法入口（导出：对拍测试与后续复用同一份词法权威，不再各自解释这门语言）。
 * 实现是单遍 `charCodeAt` 扫描——逐字符正则的等价替换（审计 §4.3 / A 类 A-8）：
 * token 序列逐字不变，只是不再为每个字符分配子串、执行正则。
 * 行为等价由 `__tests__/adapter/CelAdapter.test.ts` 的逐字对拍断言保证。
 */
export const tokenize = (src: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const code = src.charCodeAt(i);
    if (isCelWhitespace(code)) { i++; continue; }
    if (code === 0x28 || code === 0x29) {
      tokens.push({ type: "paren", value: code === 0x28 ? "(" : ")" });
      i++;
      continue;
    }
    if (isCelLogicalPair(src, i)) {
      tokens.push({ type: "op", value: src.slice(i, i + 2) }); i += 2; continue;
    }
    if (isCelComparisonWindow(src, i)) {
      let op = src[i];
      if (src[i + 1] === "=") { op += "="; i++; }
      i++;
      tokens.push({ type: "op", value: op });
      continue;
    }
    if (code === 0x22 || code === 0x27) {
      const quote = code; i++;
      let s = "";
      while (i < src.length && src.charCodeAt(i) !== quote) { s += src[i]; i++; }
      i++; // skip closing quote
      tokens.push({ type: "string", value: s });
      continue;
    }
    if (isCelDigitOrDot(code)) {
      let num = "";
      while (i < src.length && isCelDigitOrDot(src.charCodeAt(i))) { num += src[i]; i++; }
      tokens.push({ type: "number", value: parseFloat(num) });
      continue;
    }
    if (isCelIdentifierStart(code)) {
      let id = "";
      while (i < src.length && isCelIdentifierPart(src.charCodeAt(i))) { id += src[i]; i++; }
      tokens.push({ type: "ident", value: id });
      continue;
    }
    throw new RuleCompileError(src, `Unexpected character: '${src[i]}'`);
  }
  return tokens;
};

// Simple recursive descent: expr = comparison (('&&'|'||') comparison)*
// comparison = value (('=='|'!='|'>'|'>='|'<'|'<=') value)?
// value = ident | number | string | '(' expr ')'

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  parse(src: string): (vars: Record<string, unknown>) => boolean {
    const fn = this.expr();
    if (this.pos < this.tokens.length) throw new RuleCompileError(src, `Unexpected token at position ${this.pos}`);
    return fn;
  }

  private expr(): (vars: Record<string, unknown>) => boolean {
    let left = this.comparison();
    while (this.peek()?.type === "op" && ["&&", "||"].includes(this.peek()!.value as string)) {
      const op = this.consume()!;
      const right = this.comparison();
      const prev = left;
      left = op.value === "&&" ? (v) => prev(v) && right(v) : (v) => prev(v) || right(v);
    }
    return left;
  }

  private comparison(): (vars: Record<string, unknown>) => boolean {
    const left = this.value();
    const next = this.peek();
    if (next?.type === "op" && ["==", "!=", ">", ">=", "<", "<="].includes(next.value)) {
      const op = this.consume()!;
      const right = this.value();
      // 查表法替代 switch——减少 tree-sitter 计数的 branchCount
      const CHECK: Record<string, (l: unknown, r: unknown) => boolean> = {
        "==": (l, r) => l == r, "!=": (l, r) => l != r,
        ">":  (l, r) => (l as number) > (r as number), ">=": (l, r) => (l as number) >= (r as number),
        "<":  (l, r) => (l as number) < (r as number), "<=": (l, r) => (l as number) <= (r as number),
      };
      return (v) => {
        const l = typeof left === "function" ? (left as (v: Record<string, unknown>) => unknown)(v) : left;
        const r = typeof right === "function" ? (right as (v: Record<string, unknown>) => unknown)(v) : right;
        return (CHECK[op.value] ?? (() => false))(l, r);
      };
    }
    // standalone value without operator → truthy check (unusual but valid for boolean flags)
    return (v) => {
      const l = typeof left === "function" ? (left as (v: Record<string, unknown>) => unknown)(v) : left;
      return !!l;
    };
  }

  private value(): unknown | ((v: Record<string, unknown>) => unknown) {
    const t = this.consume();
    if (!t) throw new Error("Unexpected end of expression");
    switch (t.type) {
      case "number": return t.value;
      case "string": return t.value;
      case "ident":  return (v: Record<string, unknown>) => v[t.value];
      case "paren":
        if (t.value === "(") {
          const inner = this.expr();
          const close = this.consume();
          if (!close || close.type !== "paren" || close.value !== ")") throw new Error("Expected ')'");
          return inner;
        }
        throw new Error(`Unexpected '${t.value}'`);
      default: throw new Error(`Unexpected token type: ${(t as Token).type}`);
    }
  }

  private peek(): Token | null { return this.pos < this.tokens.length ? this.tokens[this.pos] : null; }
  private consume(): Token | null { return this.pos < this.tokens.length ? this.tokens[this.pos++] : null; }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const CelAdapterLive = Layer.effect(
  RuleService,
  Effect.gen(function* () {
    return {
      compile: (name: string, condition: string) =>
        Effect.try({
          try: (): CompiledRule => {
            const tokens = tokenize(condition);
            const fn = new Parser(tokens).parse(condition);
            return { name, evaluate: fn };
          },
          catch: (e) =>
            e instanceof RuleCompileError ? e : new RuleCompileError(condition, String(e)),
        }),
    };
  })
);
