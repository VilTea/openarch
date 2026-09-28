import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rustCargoTestProvider } from "../../src/test-governance/providers/rustCargoTest";

/**
 * Rust 测试文件识别（口径锁定，2026-09-27；`整改变更说明` §6.2 #3 ④）。
 *
 * 官方语义：`#[test]` 是 libtest 唯一的收集判据，但"文件是否属于测试目标"由 Cargo 决定 ——
 * `tests/*.rs` 默认是集成测试目标；`[package] autotests = false` 时**不再自动**；
 * `[[test]] path` 可声明任意路径；`[[test]] harness = false` 是自定义 harness、不是 libtest。
 * 清单不存在/解析不了 ⇒ 回退路径判据（不改事实）。
 */
const roots: string[] = [];

const project = (manifest: string | null, files: readonly string[]): string => {
  const root = mkdtempSync(join(tmpdir(), "openarch-rust-discovery-"));
  roots.push(root);
  if (manifest !== null) writeFileSync(join(root, "Cargo.toml"), manifest);
  for (const file of files) {
    const full = join(root, file);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "#[test]\nfn case() { assert_eq!(1, 1); }\n");
  }
  return root;
};

const supports = (root: string, file: string): boolean => rustCargoTestProvider.supports(join(root, file));

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("rustCargoTestProvider 测试文件识别（Cargo 目标语义）", () => {
  it("默认 autotests：tests/**/*.rs 是测试目标，src/** 不是", () => {
    const root = project(`[package]\nname = "demo"\nversion = "0.1.0"\n`, ["tests/a.rs", "src/lib.rs"]);
    expect(supports(root, "tests/a.rs")).toBe(true);
    expect(supports(root, "src/lib.rs")).toBe(false);
  });

  it("autotests = false：tests/ 下不再自动算测试，只有 [[test]] 声明的算", () => {
    const root = project(
      `[package]\nname = "demo"\nversion = "0.1.0"\nautotests = false\n\n[[test]]\nname = "declared"\npath = "tests/declared.rs"\n`,
      ["tests/undeclared.rs", "tests/declared.rs"],
    );
    expect(supports(root, "tests/undeclared.rs")).toBe(false);
    expect(supports(root, "tests/declared.rs")).toBe(true);
  });

  it("[[test]] path 可声明 tests/ 之外的目标；省略 path 时回退 tests/<name>.rs", () => {
    const root = project(
      `[package]\nname = "demo"\nversion = "0.1.0"\nautotests = false\n\n[[test]]\nname = "outside"\npath = "custom/x.rs"\n\n[[test]]\nname = "implicit"\n`,
      ["custom/x.rs", "tests/implicit.rs", "tests/other.rs"],
    );
    expect(supports(root, "custom/x.rs")).toBe(true);
    expect(supports(root, "tests/implicit.rs")).toBe(true);
    expect(supports(root, "tests/other.rs")).toBe(false);
  });

  it("harness = false 是自定义 harness 目标 ⇒ 不是 libtest，排除", () => {
    const root = project(
      `[package]\nname = "demo"\nversion = "0.1.0"\nautotests = false\n\n[[test]]\nname = "custom-harness"\npath = "tests/h.rs"\nharness = false\n`,
      ["tests/h.rs"],
    );
    expect(supports(root, "tests/h.rs")).toBe(false);
  });

  it("清单损坏或缺失 ⇒ 回退路径判据（不据此排除文件）", () => {
    const broken = project(`[package\nname = "oops"\n`, ["tests/a.rs"]);
    expect(supports(broken, "tests/a.rs")).toBe(true);
    const missing = project(null, ["tests/b.rs", "src/lib.rs"]);
    expect(supports(missing, "tests/b.rs")).toBe(true);
    expect(supports(missing, "src/lib.rs")).toBe(false);
  });

  it("向上查找最近的清单（工作区根的清单优先于子目录无清单的情形）", () => {
    const root = project(
      `[package]\nname = "demo"\nversion = "0.1.0"\nautotests = false\n\n[[test]]\nname = "only"\npath = "crates/inner/tests/only.rs"\n`,
      ["crates/inner/tests/only.rs", "crates/inner/tests/skipped.rs"],
    );
    expect(supports(root, "crates/inner/tests/only.rs")).toBe(true);
    expect(supports(root, "crates/inner/tests/skipped.rs")).toBe(false);
  });
});
