import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { parseTsText } from "../../src/adapter/parser/TsStrategy";
import { parseJavaText } from "../../src/adapter/parser/JavaStrategy";
import { projectBaselineEntry } from "../../src/application/baselineEntry";

/**
 * `maxFuncBranch` 的归属与形态（校准 2026-09-25）。
 *
 * 修复的缺陷：baseline 只持久化一个标量，WARN 明细因此无法说出是哪个函数越界，
 * Agent 只能盲拆；同时字段名像“分支个数”而取值是 0.3/1.0 的加权和，
 * 使用方只能自写脚本复刻口径。这里固定三件事：
 *   1. 归属函数是**真正**的最大值函数（不是列表里的第一个）；
 *   2. 行号可用；
 *   3. 加权值可由形态分解复算（普通 if × 1.0 + 卫语句 × 0.3 + case × 0.3）。
 */
describe("maxFuncBranchOwner：归属与可复算的形态分解", () => {
  it("定位到真正的最大分支函数（而非第一个函数）", async () => {
    const ast = await Effect.runPromise(parseTsText("a.ts", [
      "export function small(x?: string) {",
      "  if (!x) return;",
      "}",
      "export function big(a: number, b: number, c: number) {",
      "  if (a > 0) { console.log(a); }",
      "  if (b > 0) { console.log(b); }",
      "  if (c > 0) { console.log(c); }",
      "}",
    ].join("\n")));
    const entry = projectBaselineEntry({ ast, fileKind: "production", inDegree: 0, alphaStruct: 0 });
    expect(entry.maxFuncBranchOwner?.name).toBe("big");
    expect(entry.maxFuncBranchOwner?.line).toBe(4);
    expect(entry.maxFuncBranchOwner?.weighted).toBeCloseTo(3.0, 5);
  });

  it("形态分解可以复算加权值（普通 if 1.0 / 卫语句 0.3 / case 0.3）", async () => {
    const ast = await Effect.runPromise(parseJavaText("A.java", [
      "class A {",
      "  int run(String v) {",
      "    if (v == null) { return 0; }",        // 卫语句（花括号形态）
      "    if (v.isEmpty()) return -1;",          // 卫语句（无花括号形态，两种形态等价）
      "    if (v.length() > 2) { return 2; }",    // 卫语句（体内唯一语句是 return）
      "    if (v.length() == 1) { System.out.println(v); }", // 普通 if
      "    switch (v) { case \"a\": return 1; default: return 0; }", // switch 本身=普通(1.0) + 每个 case label 0.3
      "  }",
      "}",
    ].join("\n")));
    const owner = projectBaselineEntry({ ast, fileKind: "production", inDegree: 0, alphaStruct: 0 }).maxFuncBranchOwner;
    expect(owner).toBeDefined();
    expect(owner!.guardIf).toBe(3);
    expect(owner!.ordinaryIf).toBe(2);   // 1 个普通 if + 1 个 switch_expression
    expect(owner!.caseCount).toBe(2);    // case + default
    // 分解必须能复算加权值：这是“maxFuncBranch 是加权和”的唯一可验证表达。
    const recomputed = owner!.ordinaryIf * 1.0 + (owner!.guardIf + owner!.caseCount) * 0.3;
    expect(recomputed).toBeCloseTo(owner!.weighted, 5);
    expect(ast.maxFuncBranch).toBeCloseTo(owner!.weighted, 5);
  });

  it("非生产文件不写入该事实（与其它局部负担事实同一边界）", async () => {
    const ast = await Effect.runPromise(parseTsText("a.test.ts", "export function f(x?: string) { if (x) { console.log(x); } }"));
    const entry = projectBaselineEntry({ ast, fileKind: "test", inDegree: 0, alphaStruct: 0 });
    expect(entry.maxFuncBranchOwner).toBeUndefined();
  });

  it("无分支函数不产生归属条目（避免用 0 冒充事实）", async () => {
    const ast = await Effect.runPromise(parseTsText("a.ts", "export function f() { return 1; }"));
    const entry = projectBaselineEntry({ ast, fileKind: "production", inDegree: 0, alphaStruct: 0 });
    expect(entry.maxFuncBranchOwner).toBeUndefined();
  });

  it("同一权威同时产出单调用点助手占比（与 connectedness 同源）", async () => {
    // main 各调一次 a/b/c ⇒ 三个助手都是单调用点；图仍然连通（connectedness=1）。
    const ast = await Effect.runPromise(parseTsText("a.ts", [
      "export function main() { a(); b(); c(); }",
      "function a() { return 1; }",
      "function b() { return 2; }",
      "function c() { return 3; }",
    ].join("\n")));
    const entry = projectBaselineEntry({ ast, fileKind: "production", inDegree: 0, alphaStruct: 0 });
    expect(entry.connectedness).toBe(1);
    expect(entry.singleCallSiteRatio).toBe(1);
  });

  it("文件内无调用点时该事实缺席（不是 0）", async () => {
    const ast = await Effect.runPromise(parseTsText("a.ts", "export function f() { return 1; }\nexport function g() { return 2; }"));
    const entry = projectBaselineEntry({ ast, fileKind: "production", inDegree: 0, alphaStruct: 0 });
    // 两个互不调用的函数：连通度是 0.5（两个分量），而"单调用点助手占比"**不可判定**——
    // 两者是同一张图的两个投影，一个可判定不代表另一个也可判定。
    expect(entry.connectedness).toBe(0.5);
    expect(entry.singleCallSiteRatio).toBeUndefined();
  });
});
