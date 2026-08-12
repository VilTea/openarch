import { describe, expect, it } from "vitest";
import { assertionWrapperScope, namedFunctionsFrom } from "../../src/test-governance/assertionScope";

describe("assertionWrapperScope（语法级 helper 断言，2026-08-12 体验反馈）", () => {
  it("recognises a named function whose body contains a direct assertion as a wrapper", () => {
    const scope = assertionWrapperScope(
      namedFunctionsFrom([
        { name: "validateThrows", bodyStart: 3, bodyEnd: 7 },
        { name: "setup", bodyStart: 9, bodyEnd: 10 },
      ]),
      [5], // 第 5 行在 validateThrows 体内 → 包装
    );
    expect(scope.isAssertionCall("validateThrows")).toBe(true);
    expect(scope.isAssertionCall("setup")).toBe(false);
    expect(scope.isAssertionCall("expect")).toBe(true);
    expect(scope.isAssertionCall("assert")).toBe(true);
  });

  it("does not rely on naming conventions: arbitrary helper names with assertion bodies count", () => {
    const scope = assertionWrapperScope(
      namedFunctionsFrom([{ name: "checkResult", bodyStart: 1, bodyEnd: 4 }]),
      [2],
    );
    expect(scope.isAssertionCall("checkResult")).toBe(true);
  });

  it("rejects non-wrapper calls even with assertion-like names", () => {
    // 名为 shouldRender 但体内无断言 → 不是断言包装（语法级，不看名字）
    const scope = assertionWrapperScope(
      namedFunctionsFrom([{ name: "shouldRender", bodyStart: 1, bodyEnd: 4 }]),
      [],
    );
    expect(scope.isAssertionCall("shouldRender")).toBe(false);
  });

  it("maps multiple wrappers independently", () => {
    const scope = assertionWrapperScope(
      namedFunctionsFrom([
        { name: "a", bodyStart: 1, bodyEnd: 3 },
        { name: "b", bodyStart: 5, bodyEnd: 8 },
      ]),
      [2, 6],
    );
    expect(scope.isAssertionCall("a")).toBe(true);
    expect(scope.isAssertionCall("b")).toBe(true);
    expect(scope.directAssertionLines).toEqual([2, 6]);
  });
});
