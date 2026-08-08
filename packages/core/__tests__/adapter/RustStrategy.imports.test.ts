// RustStrategy import 提取端到端测试——验证 use_declaration + 内联 crate:: 路径
// 表达式都被提取为跨文件依赖，宏体内的 crate:: 保持边界（tree-sitter token_tree
// 不解析宏体结构）。校准 2026-08-05：serde format.rs 文件级上界因缺内联提取为 0。
import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parserStrategyForFile } from "../../src/adapter/parser/LanguageRegistry";

const rustFixture = (body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "oa-rust-import-"));
  const file = join(dir, "module", "impl.rs");
  const { dirname } = require("node:path") as typeof import("node:path");
  const fs = require("node:fs") as typeof import("node:fs");
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.mkdirSync(join(dir, "src"), { recursive: true });
  fs.writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.1.0"\n');
  fs.writeFileSync(join(dir, "src", "format.rs"), "pub struct Buf<'a> { bytes: &'a mut [u8] }\nimpl<'a> Buf<'a> { pub fn new(bytes: &'a mut [u8]) -> Self { Buf { bytes } } }\n");
  fs.writeFileSync(file, body);
  return file;
};

describe("RustStrategy import extraction", () => {
  it("extracts both use declarations and inline crate:: path expressions as cross-file dependencies", async () => {
    const file = rustFixture(`
use crate::lib::*;
use crate::format::Buf;

fn render() -> String {
    let mut buf = [0u8; 32];
    let mut writer = crate::format::Buf::new(&mut buf);
    drop(writer);
    String::new()
}
`);
    const ast = await Effect.runPromise(parserStrategyForFile(file)!.parse(file));
    const targets = ast.imports
      .map((r) => r.resolvedPath?.split("src").at(-1))
      .filter((p): p is string => p != null && p.includes("format"));
    expect(targets).toContain("/format.rs"); // use crate::format::Buf
    expect(targets.filter((p) => p === "/format.rs").length).toBeGreaterThanOrEqual(2); // use + 内联 crate::format::Buf::new
    expect(ast.imports.some((r) => r.source.includes("crate::lib"))).toBe(true);
  });

  it("keeps macro-body crate:: paths as a boundary (tree-sitter token_tree is not parsed)", async () => {
    const file = rustFixture(`
macro_rules! bounded_display {
    ($value:expr, $serializer:expr) => {{
        let mut buffer = [0u8; 128];
        let mut writer = crate::format::Buf::new(&mut buffer);
        $serializer.serialize_str(writer.as_str())
    }};
}

fn no_macro_use() -> u8 { 0 }
`);
    const ast = await Effect.runPromise(parserStrategyForFile(file)!.parse(file));
    const formatTargets = ast.imports.filter((r) => r.resolvedPath?.includes("format.rs"));
    // 宏体 crate:: 不被静态提取——token_tree 内无 scoped_identifier 节点。
    expect(formatTargets).toHaveLength(0);
  });
});
