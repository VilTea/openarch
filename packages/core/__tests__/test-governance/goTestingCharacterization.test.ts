import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ParserService } from "../../src/port/ParserService";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { goTestingProvider } from "../../src/test-governance/providers/goTesting";
import type { TestProviderResult } from "../../src/test-governance/provider";

/**
 * 特征化矩阵（口径锁定，2026-09-27）。
 *
 * 纪律：本文件的期望值**全部取自改动前实现的实测输出**（临时探针打印
 * `JSON.stringify` 后逐字粘贴），不是从规则反推的"应该有"。
 * 每条期望都是**精确值**（`assertionCount: N`），不是 `toBeGreaterThan(0)` ——
 * 断言计数会进 P95/校准证据，松断言会让下一条修正悄悄漂移。
 *
 * 语料覆盖（§6.2 #3 ①② 的取证要求）：
 * - 测试名判据：`TestFoo` / `Test_foo` / `Test1` / `TestFooBar` / `testFoo`（必须不计）/
 *   无参函数 / `*testing.T` 与 `testing.TB` 接收者 / 名字以 `Test` 开头但无 `*testing.T` 的助手；
 * - 断言识别：`t.Error` / `t.Errorf` / `t.Fatal` / `t.Fatalf`、自定义类型 `x.Error()` 同名调用、
 *   `if a != b { t.Errorf(...) }`、`t.Run` 表驱动子测试、仅 panic 的用例；
 * - benchmark/example：官方 `func BenchmarkXxx(*testing.B)` 的形状按当前 provider 口径记录。
 */
const dir = join(tmpdir(), `openarch-go-testing-characterization-${Date.now()}`);
const file = join(dir, "characterization_test.go");

const source = `package characterization

import "testing"

type custom struct{}

func (c custom) Error() string { return "boom" }

var a int
var b int

func TestFoo(t *testing.T) {
	if a != b {
		t.Errorf("a = %v; want %v", a, b)
	}
}

func Test_foo(t *testing.T) {
	if a != b {
		t.Error("mismatch")
	}
}

func Test1(t *testing.T) {
	t.Fatal("failed")
}

func TestFooBar(t *testing.T) {
	t.Fatalf("failed %v", 1)
}

func testFoo(t *testing.T) {
	if a != b {
		t.Errorf("a = %v; want %v", a, b)
	}
}

func TestNoParam() {}

func TestT(t *testing.T) {
	if a != b {
		t.Errorf("a = %v; want %v", a, b)
	}
}

func TestTB(t testing.TB) {
	if a != b {
		t.Errorf("a = %v; want %v", a, b)
	}
}

func TestHelperNoT(value string) {
	_ = value
}

func TestErrorBare(t *testing.T) {
	t.Error("failed")
}

func TestErrorf(t *testing.T) {
	t.Errorf("failed %d", 1)
}

func TestFatal(t *testing.T) {
	t.Fatal("failed")
}

func TestLookalike(t *testing.T) {
	var x custom
	_ = x.Error()
}

func TestTableDriven(t *testing.T) {
	tests := []struct{ name string }{{"a"}}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if a != b {
				t.Errorf("a = %v; want %v", a, b)
			}
		})
	}
}

func TestPanicOnly(t *testing.T) {
	panic("boom")
}

func TestNilCheck(t *testing.T) {
	var err error
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
}

func TestPureComparison(t *testing.T) {
	if a != b {
		return
	}
}

func TestCallInCondition(t *testing.T) {
	if t.Failed() {
		return
	}
}

func BenchmarkFoo(b *testing.B) {
	for b.Loop() {
	}
}

func Benchmark_foo(b *testing.B) {
	for b.Loop() {
	}
}

func ExampleFoo() {
	println("x")
}
`;

const collect = (): Effect.Effect<TestProviderResult> => Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* Effect.promise(() => goTestingProvider.collect(file, parser));
}).pipe(Effect.provide(TreeSitterParserLive), Effect.orDie);

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, source);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("goTestingProvider characterization", () => {
  it("pins the exact recognised test population for the current naming judgment", async () => {
    const result = await Effect.runPromise(collect());
    expect(result.tests.map((test) => test.name)).toEqual([
      "TestFoo",
      "Test_foo",
      "Test1",
      "TestFooBar",
      "TestT",
      "TestErrorBare",
      "TestErrorf",
      "TestFatal",
      "TestLookalike",
      "TestTableDriven",
      "TestPanicOnly",
      "TestNilCheck",
      "TestPureComparison",
      "TestCallInCondition",
    ]);
  }, 20000);

  it("pins the exact per-case assertion counts and control-flow weights", async () => {
    const result = await Effect.runPromise(collect());
    expect(result.tests.map((test) => ({
      name: test.name,
      loc: test.loc,
      assertionCount: test.assertionCount,
      mockCount: test.mockCount,
      controlFlow: test.testBodyControlFlow,
    }))).toEqual([
      { name: "TestFoo", loc: 5, assertionCount: 1, mockCount: 0, controlFlow: 1 },
      { name: "Test_foo", loc: 5, assertionCount: 1, mockCount: 0, controlFlow: 1 },
      { name: "Test1", loc: 3, assertionCount: 1, mockCount: 0, controlFlow: 0 },
      { name: "TestFooBar", loc: 3, assertionCount: 1, mockCount: 0, controlFlow: 0 },
      { name: "TestT", loc: 5, assertionCount: 1, mockCount: 0, controlFlow: 1 },
      { name: "TestErrorBare", loc: 3, assertionCount: 1, mockCount: 0, controlFlow: 0 },
      { name: "TestErrorf", loc: 3, assertionCount: 1, mockCount: 0, controlFlow: 0 },
      { name: "TestFatal", loc: 3, assertionCount: 1, mockCount: 0, controlFlow: 0 },
      { name: "TestLookalike", loc: 4, assertionCount: 0, mockCount: 0, controlFlow: 0 },
      // 表驱动父用例：子测试体的断言**不属于**父用例体（offset 归属，与 findings 循环同一权威），
      // 父用例自身没有断言 ⇒ 0。改前是 1，原因是旧计数按行号包含，把嵌套 `t.Run` 闭包内的
      // `t.Errorf` 也算到父用例头上（归属粗化，不是"父用例有断言"）。
      { name: "TestTableDriven", loc: 10, assertionCount: 0, mockCount: 0, controlFlow: 0 },
      { name: "TestPanicOnly", loc: 3, assertionCount: 0, mockCount: 0, controlFlow: 0 },
      { name: "TestNilCheck", loc: 6, assertionCount: 1, mockCount: 0, controlFlow: 1 },
      // `if a != b { return }`：第三层证据取"`if` 条件形态的决策点"，条件里没有失败调用 ⇒ 该守卫计 1。
      { name: "TestPureComparison", loc: 5, assertionCount: 1, mockCount: 0, controlFlow: 1 },
      // `if t.Failed() { return }`：`T.Failed` 是查询状态、不产生失败信号，计数仍为 1；
      // 但来源由旧口径的"行内 `t.Failed()` 调用"变为新口径的"条件形态守卫"（`consequence` 只取体）。
      { name: "TestCallInCondition", loc: 5, assertionCount: 1, mockCount: 0, controlFlow: 1 },
    ]);
  }, 20000);

  it("pins the exact test-case spans and findings", async () => {
    const result = await Effect.runPromise(collect());
    expect(result.testCaseSpans).toEqual([
      { name: "TestFoo", startLine: 12, endLine: 16, statuses: [] },
      { name: "Test_foo", startLine: 18, endLine: 22, statuses: [] },
      { name: "Test1", startLine: 24, endLine: 26, statuses: [] },
      { name: "TestFooBar", startLine: 28, endLine: 30, statuses: [] },
      { name: "TestT", startLine: 40, endLine: 44, statuses: [] },
      { name: "TestErrorBare", startLine: 56, endLine: 58, statuses: [] },
      { name: "TestErrorf", startLine: 60, endLine: 62, statuses: [] },
      { name: "TestFatal", startLine: 64, endLine: 66, statuses: [] },
      { name: "TestLookalike", startLine: 68, endLine: 71, statuses: [] },
      { name: "TestTableDriven", startLine: 73, endLine: 82, statuses: [] },
      { name: "TestPanicOnly", startLine: 84, endLine: 86, statuses: [] },
      { name: "TestNilCheck", startLine: 88, endLine: 93, statuses: [] },
      { name: "TestPureComparison", startLine: 95, endLine: 99, statuses: [] },
      { name: "TestCallInCondition", startLine: 101, endLine: 105, statuses: [] },
    ]);
    expect(result.findings).toEqual([]);
  }, 20000);

  it("does not count names that are not collectable tests (negative controls stay at their pinned values)", async () => {
    const result = await Effect.runPromise(collect());
    const names = result.tests.map((test) => test.name);
    expect(names).not.toContain("testFoo");
    expect(names).not.toContain("TestNoParam");
    expect(names).not.toContain("TestTB");
    expect(names).not.toContain("TestHelperNoT");
    expect(names).not.toContain("BenchmarkFoo");
    expect(names).not.toContain("Benchmark_foo");
    expect(names).not.toContain("ExampleFoo");
  }, 20000);

  it("does not attribute a subtest's assertion to the parent test body", async () => {
    const result = await Effect.runPromise(collect());
    const tableDriven = result.tests.find((test) => test.name === "TestTableDriven");
    // 归属纪律：`t.Run` 的 `func_literal` 是子测试体，其断言不归父用例
    // （与同一 provider 的 findings 循环、`controlFlow.ts` 的嵌套排除同一权威）。
    expect(tableDriven?.assertionCount).toBe(0);
    const ownAssertion = result.tests.find((test) => test.name === "TestFoo");
    expect(ownAssertion?.assertionCount).toBe(1);
  }, 20000);
});
