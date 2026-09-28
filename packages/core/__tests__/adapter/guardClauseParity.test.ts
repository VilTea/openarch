import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { parseTsText } from "../../src/adapter/parser/TsStrategy";
import { parseJavaText } from "../../src/adapter/parser/JavaStrategy";
import { parseGoText } from "../../src/adapter/parser/GoStrategy";
import { parsePythonText } from "../../src/adapter/parser/PythonStrategy";
import { parseRustText } from "../../src/adapter/parser/RustStrategy";

/**
 * 卫语句判据的跨语言一致性回归（认知点原则：一个概念只有一个权威入口）。
 *
 * 0.1.5 的实测事实：TS 与 Java 各写了一份卫语句判据且互相镜像 ——
 *   TS   `if (!x) { return; }` → 1.0（读 children[0] 拿到 `{`），`if (!x) return;` → 0.3
 *   Java `if (x == null) { return; }` → 0.3，`if (x == null) return;` → 1.0
 * 即：两边只有对方漏判的那种形态被识别。本用例把“花括号不该改变权重”固定下来，
 * 使判据无法再以“某个语言自己的实现”为名重新分叉。
 */

interface Probe {
  readonly language: string;
  /** 带花括号的卫语句（若该语言语法允许/要求）。 */
  readonly bracedGuard?: string;
  /** 不带花括号的等价卫语句（若该语言语法允许）。 */
  readonly bareGuard?: string;
  /** 普通 if（带体），用于对照卫语句与普通分支必须不同权。 */
  readonly ordinary: string;
}

const probes: readonly Probe[] = [
  {
    language: "typescript",
    bracedGuard: "export function f(x?: string) { if (!x) { return; } }",
    bareGuard: "export function f(x?: string) { if (!x) return; }",
    ordinary: "export function f(x?: string) { if (x) { console.log(x); } }",
  },
  {
    language: "java",
    bracedGuard: "class A { void f(String x) { if (x == null) { return; } } }",
    bareGuard: "class A { void f(String x) { if (x == null) return; } }",
    ordinary: "class A { void f(String x) { if (x != null) { System.out.println(x); } } }",
  },
  {
    language: "go",
    bracedGuard: 'package p\nfunc f(x string) { if x == "" { return } }',
    ordinary: 'package p\nfunc f(x string) { if x != "" { println(x) } }',
  },
  {
    language: "python",
    bracedGuard: "def f(x):\n    if not x:\n        return\n",
    ordinary: "def f(x):\n    if x:\n        print(x)\n",
  },
  {
    language: "rust",
    bracedGuard: 'fn f(x: &str) { if x.is_empty() { return; } }',
    ordinary: 'fn f(x: &str) { if !x.is_empty() { println!("{}", x); } }',
  },
];

const parse = async (probe: Probe, source: string): Promise<number> => {
  const ast = await Effect.runPromise(
    probe.language === "typescript" ? parseTsText("probe.ts", source)
      : probe.language === "java" ? parseJavaText("Probe.java", source)
        : probe.language === "go" ? parseGoText("probe.go", source)
          : probe.language === "python" ? parsePythonText("probe.py", source)
            : parseRustText("probe.rs", source),
  );
  return ast.maxFuncBranch ?? 0;
};

describe("卫语句判据跨语言一致（唯一权威实现）", () => {
  for (const probe of probes) {
    it(`${probe.language}：卫语句记 0.3，普通 if 记 1.0`, async () => {
      expect(await parse(probe, probe.ordinary)).toBeCloseTo(1.0, 5);
      if (probe.bracedGuard) expect(await parse(probe, probe.bracedGuard)).toBeCloseTo(0.3, 5);
      if (probe.bareGuard) expect(await parse(probe, probe.bareGuard)).toBeCloseTo(0.3, 5);
    });
  }

  it("花括号不得改变权重：等价形态必须同值", async () => {
    for (const probe of probes) {
      if (!probe.bracedGuard || !probe.bareGuard) continue;
      expect(await parse(probe, probe.bracedGuard), `${probe.language} braced vs bare`)
        .toBeCloseTo(await parse(probe, probe.bareGuard), 5);
    }
  });

  it("卫语句 + 普通 if 的组合权重是 1.3（校准口径可复算）", async () => {
    const combined: readonly (readonly [Probe, string])[] = [
      [{ ...probes[0]!, bracedGuard: undefined, bareGuard: undefined },
        "export function f(x?: string) { if (!x) { return; } if (x) { console.log(x); } }"],
      [{ ...probes[1]!, bracedGuard: undefined, bareGuard: undefined },
        "class A { void f(String x) { if (x == null) return; if (x != null) { System.out.println(x); } } }"],
    ];
    for (const [probe, source] of combined) {
      expect(await parse(probe, source), probe.language).toBeCloseTo(1.3, 5);
    }
  });
});
