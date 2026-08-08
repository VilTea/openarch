// tree-sitter Query API 端到端测试——验证 TsStrategy.query() 正确捕获 AST 节点
import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { resolve } from "node:path";

// 直接调 queryTs（绕过 ParserService port，测 adapter 层）
import { queryTs } from "../../src/adapter/parser/TsStrategy";

const fixture = (name: string) => resolve(__dirname, "..", "..", "fixtures", name);

describe("TsStrategy.query", () => {
  it("query 命中 call_expression 并捕获方法名 + event 字符串", async () => {
    const pattern = `(call_expression
  function: (member_expression
    property: (property_identifier) @method)
  arguments: (arguments (string) @event))`;

    const either = await Effect.runPromise(
      queryTs(fixture("eventbus-demo.ts"), pattern).pipe(Effect.either),
    );
    expect(either._tag).toBe("Right");
    const matches = either._tag === "Right" && either.right ? either.right : [];
    expect(matches.length).toBeGreaterThanOrEqual(2); // emit + on 两次调用

    // 验证捕获的 method 和 event
    const methods = matches.flatMap(m => m.captures.filter(c => c.name === "method").map(c => c.text));
    expect(methods).toContain("emit");
    expect(methods).toContain("on");

    const events = matches.flatMap(m => m.captures.filter(c => c.name === "event").map(c => c.text));
    expect(events.some(e => e.includes("order.created"))).toBe(true);
  }, 15000);

  it("query 不匹配不存在的模式 → 空结果", async () => {
    const pattern = "(call_expression (super) @x)";  // 无 super 关键字
    const either = await Effect.runPromise(
      queryTs(fixture("eventbus-demo.ts"), pattern).pipe(Effect.either),
    );
    expect(either._tag).toBe("Right");
    const matches = either._tag === "Right" && either.right ? either.right : [];
    expect(matches).toHaveLength(0);
  }, 15000);

  it("无效 pattern → Left(ParseError)", async () => {
    const either = await Effect.runPromise(
      queryTs(fixture("eventbus-demo.ts"), "[[[ invalid }}}").pipe(Effect.either),
    );
    expect(either._tag).toBe("Left");
  }, 15000);
});
