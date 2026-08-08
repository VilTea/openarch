import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { RuleService, RuleCompileError } from "../../src/port/RuleService";
import { CelAdapterLive } from "../../src/adapter/rule/CelAdapter";

const compile = (name: string, expr: string) =>
  Effect.gen(function* () {
    const svc = yield* RuleService;
    return yield* svc.compile(name, expr);
  }).pipe(Effect.provide(CelAdapterLive));

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
