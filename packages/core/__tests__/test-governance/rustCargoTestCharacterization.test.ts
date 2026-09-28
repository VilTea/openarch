import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ParserService } from "../../src/port/ParserService";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { rustCargoTestProvider } from "../../src/test-governance/providers/rustCargoTest";
import type { TestProviderResult } from "../../src/test-governance/provider";

/**
 * Rust 断言宏族的特征化矩阵（口径锁定，2026-09-27；`整改变更说明` §6.2 #3 ③）。
 *
 * 纪律：期望值取自**改动前实现的实测输出**（临时探针打印 JSON 后逐字抄入），随后只把本项
 * 修正**有意改变**的那两条改成修正后的值，并在注释里同时留下改前值 —— 便于未来对拍。
 *
 * 改前实测（同一语料）：`assert_matches_only = 0`、`debug_assert_matches_only = 0`；
 * 其余用例与 findings **完全不变**（`bodyCalls` 已把宏调用算作"有验证意图"，所以本次修复
 * **不改变任何 finding**，只改变 `assertionCount`）。
 */
const dir = join(tmpdir(), `openarch-rust-characterization-${Date.now()}`);
const file = join(dir, "characterization.rs");

const source = `fn helper() -> bool { true }

#[test]
fn assert_eq_only() {
    assert_eq!(1, 1);
}

#[test]
fn assert_matches_only() {
    assert_matches!(Some(1), Some(_));
}

#[test]
fn debug_assert_matches_only() {
    debug_assert_matches!(Some(1), Some(_));
}

#[test]
fn matches_expr_only() {
    let _ok = matches!(Some(1), Some(_));
}

#[test]
fn assert_matches_wrapped_in_assert() {
    assert!(matches!(Some(1), Some(_)));
}

#[test]
fn nested_closure_assert() {
    let f = || { assert_eq!(1, 1); };
    f();
}

#[test]
fn empty_body() {}

#[test]
fn delegated_call_only() {
    helper();
}

#[test]
#[ignore]
fn ignored_assert_matches() {
    assert_matches!(Some(1), Some(_));
}
`;

const collect = (): Effect.Effect<TestProviderResult> => Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* Effect.promise(() => rustCargoTestProvider.collect(file, parser));
}).pipe(Effect.provide(TreeSitterParserLive), Effect.orDie);

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, source);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("rustCargoTestProvider characterization", () => {
  it("pins per-case assertion counts with the official macro family", async () => {
    const result = await Effect.runPromise(collect());
    expect(result.tests.map((test) => ({ name: test.name, loc: test.loc, assertionCount: test.assertionCount, statuses: test.statuses }))).toEqual([
      { name: "assert_eq_only", loc: 3, assertionCount: 1, statuses: [] },
      // 改前 0；官方把 assert_matches! 与 assert_eq! 并列（依据见提供方注释与 rust.md）。
      { name: "assert_matches_only", loc: 3, assertionCount: 1, statuses: [] },
      { name: "debug_assert_matches_only", loc: 3, assertionCount: 1, statuses: [] },
      // matches! 是返回 bool 的表达式宏 ⇒ 不计断言（改前 0，改后仍 0）。
      { name: "matches_expr_only", loc: 3, assertionCount: 0, statuses: [] },
      // assert!(matches!(…)) 由 assert 计 1（matches! 不重复计）。
      { name: "assert_matches_wrapped_in_assert", loc: 3, assertionCount: 1, statuses: [] },
      // 闭包体是独立单位：其断言不归父用例（与同一 provider 的嵌套排除口径一致）。
      { name: "nested_closure_assert", loc: 4, assertionCount: 0, statuses: [] },
      { name: "empty_body", loc: 1, assertionCount: 0, statuses: [] },
      { name: "delegated_call_only", loc: 3, assertionCount: 0, statuses: [] },
      { name: "ignored_assert_matches", loc: 3, assertionCount: 1, statuses: ["ignored"] },
    ]);
  }, 20000);

  it("pins the findings: the macro-family fix changes no finding", async () => {
    const result = await Effect.runPromise(collect());
    // 改前与改后完全一致（宏调用本来就算 bodyCalls ⇒ 不报 missing_assertion）。
    expect(result.findings.map((finding) => ({ testName: finding.testName, kind: finding.kind }))).toEqual([
      { testName: "ignored_assert_matches", kind: "unapproved_skip" },
      { testName: "empty_body", kind: "missing_assertion" },
    ]);
  }, 20000);
});
