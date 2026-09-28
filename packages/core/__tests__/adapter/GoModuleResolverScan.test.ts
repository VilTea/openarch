// go.mod 单遍有界扫描器的**行为特征矩阵**。
//
// 每条期望值都来自**改动前实现的真实输出**（临时探针逐例打印 `JSON.stringify` 后原样抄入，探针已删除）：
//   npx tsx .oracle-probe.mts
// 矩阵的用途是"锁行为再动结构"：重构 `GoModuleResolver.ts` 的局部复杂度时，
// accept set（module 路径 / unprovable / null 三态）必须逐字不变。
import { describe, expect, it } from "vitest";
import { GO_MOD_SCAN_MAX_LINES, scanGoMod, type GoModScan } from "../../src/adapter/parser/GoModuleResolver";

const lines = (...rows: readonly string[]): string => rows.join("\n");

interface ScanCase {
  readonly name: string;
  readonly input: string;
  /** 改动前实现的真实输出（原样，不是推导值）。 */
  readonly expected: GoModScan;
}

const CASES: readonly ScanCase[] = [
  { name: "bare module path", input: lines("module example.com/m", "go 1.21", ""), expected: { modulePath: "example.com/m", unprovable: false } },
  { name: "backtick path", input: lines("module `example.com/backtick`", ""), expected: { modulePath: "example.com/backtick", unprovable: false } },
  { name: "double-quoted path", input: lines('module "example.com/quoted"', ""), expected: { modulePath: "example.com/quoted", unprovable: false } },
  // Go 字符串里 `\\` 与 `\"` 是合法转义；解析后应当还原成 `\` 与 `"`。
  { name: "quoted legal escapes", input: lines('module "example.com/a\\\\b\\"c"', ""), expected: { modulePath: 'example.com/a\\b"c', unprovable: false } },
  // `\t` 不是本解析器支持的转义 ⇒ 不猜，报不可用。
  { name: "unsupported escape", input: lines('module "example.com/a\\tb"', ""), expected: { modulePath: null, unprovable: true } },
  { name: "line comment after directive", input: lines("module example.com/m // 模块路径", "go 1.21", ""), expected: { modulePath: "example.com/m", unprovable: false } },
  { name: "whole-line comment", input: lines("// module example.com/commented", "module example.com/real", ""), expected: { modulePath: "example.com/real", unprovable: false } },
  { name: "leading and trailing whitespace", input: lines("   \tmodule\texample.com/spaced\t  ", ""), expected: { modulePath: "example.com/spaced", unprovable: false } },
  { name: "CRLF input", input: "module example.com/crlf\r\ngo 1.21\r\n", expected: { modulePath: "example.com/crlf", unprovable: false } },
  { name: "block comment", input: lines("module example.com/m", "/* 未闭合", ""), expected: { modulePath: "example.com/m", unprovable: true } },
  { name: "block comment one line", input: lines("/* module example.com/hidden */", "module example.com/m", ""), expected: { modulePath: "example.com/m", unprovable: true } },
  { name: "require block", input: lines("module example.com/m", "require (", "\texample.com/dep v1.2.3", ")", ""), expected: { modulePath: "example.com/m", unprovable: false } },
  // 块内的 `module` 行不是顶层指令：既不取值，也不因此报不可用（未闭合块才会）。
  { name: "module line inside a block", input: lines("require (", "\tmodule example.com/not-a-directive", ")", ""), expected: { modulePath: null, unprovable: false } },
  { name: "unmatched extra paren", input: lines("module example.com/m", ")", ""), expected: { modulePath: "example.com/m", unprovable: true } },
  { name: "unclosed block", input: lines("module example.com/m", "require (", "\texample.com/dep v1.2.3", ""), expected: { modulePath: "example.com/m", unprovable: true } },
  // 重复 module：保留第一个，但整份文件不可用（不静默挑一个）。
  { name: "duplicate module directives", input: lines("module example.com/a", "module example.com/b", ""), expected: { modulePath: "example.com/a", unprovable: true } },
  { name: "no head identifier (dash)", input: lines("-module example.com/m", ""), expected: { modulePath: null, unprovable: true } },
  { name: "no head identifier (digits)", input: lines("123 module example.com/m", ""), expected: { modulePath: null, unprovable: true } },
  // 裸 token 里出现 `"` 不可能是合法路径 ⇒ 不猜。
  { name: "path with quote inside bare token", input: lines('module example.com/a"b', ""), expected: { modulePath: null, unprovable: true } },
  { name: "empty input", input: "", expected: { modulePath: null, unprovable: false } },
  // 嵌套未闭合块把后续顶层 module 一起吞掉 ⇒ 不可用。
  { name: "module inside a nested unclosed block then module after", input: lines("require (", "\tmodule example.com/inner", "", "module example.com/outer", ""), expected: { modulePath: null, unprovable: true } },
  // 行注释截断发生在前：`//` 之后被切掉，剩下的引号未闭合 ⇒ 不可用（路径本身不可能含 `//`）。
  { name: "quote with line comment truncation", input: lines('module "example.com/m//nested"', ""), expected: { modulePath: null, unprovable: true } },
];

describe("scanGoMod（go.mod 单遍有界扫描，特征矩阵）", () => {
  it("pins the whole crafted corpus at once", () => {
    const actual = CASES.map((testCase) => ({ name: testCase.name, output: scanGoMod(testCase.input) }));
    expect(actual).toEqual(CASES.map((testCase) => ({ name: testCase.name, output: testCase.expected })));
  });

  it("keeps the matrix size visible so the table cannot silently shrink", () => {
    expect(CASES.length).toBe(22);
  });

  it("treats the bounded scan window as the authority (module at line 513 of 600 is not read)", () => {
    const beyondBound = Array.from({ length: 600 }, (_value, index) => (index === 512 ? "module example.com/late" : "// filler")).join("\n");
    // 600 行、module 落在第 513 行（界外）：结果是"未解析"，而不是"猜一个路径"。
    expect(scanGoMod(beyondBound)).toEqual({ modulePath: null, unprovable: false });
  });

  it("still proves a module directive inside the bound even when the file is longer than the bound", () => {
    const insideBound = lines("module example.com/early", ...Array.from({ length: 600 }, () => "// filler"), "");
    expect(scanGoMod(insideBound)).toEqual({ modulePath: "example.com/early", unprovable: false });
  });

  it("reads the bound from the exported constant, not a duplicated literal", () => {
    const exactlyAtBound = lines(...Array.from({ length: GO_MOD_SCAN_MAX_LINES - 1 }, () => "// filler"), "module example.com/last", "");
    const onePastBound = lines(...Array.from({ length: GO_MOD_SCAN_MAX_LINES }, () => "// filler"), "module example.com/past", "");
    expect(scanGoMod(exactlyAtBound)).toEqual({ modulePath: "example.com/last", unprovable: false });
    expect(scanGoMod(onePastBound)).toEqual({ modulePath: null, unprovable: false });
  });
});
