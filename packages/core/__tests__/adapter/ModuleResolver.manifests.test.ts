// 审计 C-5 回归：manifest 不再"用正则读整份文件"。
//   Rust：`Cargo.toml` 用 smol-toml 解析结果判定 `[package]` 表（`description = "[package]"`
//         这类字符串不再误判）；解析失败 = 不可用（返回未解析），不猜。
//   Go：`go.mod` 用单遍有界行扫描器读 module 指令（块注释 / 未闭合块 / 重复或畸形 module
//       一律报不可用），不是全文正则。
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GO_MOD_SCAN_MAX_LINES, goModuleResolver } from "../../src/adapter/parser/GoModuleResolver";
import { rustModuleResolver } from "../../src/adapter/parser/RustModuleResolver";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

const write = (root: string, files: Readonly<Record<string, string>>): void => {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
};

const resolved = (root: string, importer: string, source: string, resolver: typeof goModuleResolver): readonly string[] =>
  resolver.resolveLocal(join(root, importer), source);

describe("goModuleResolver（go.mod 单遍有界扫描）", () => {
  it("reads the module directive out of a realistic go.mod", async () => {
    await withTemporaryDirectory("go-mod", (root) => {
      write(root, {
        "go.mod": [
          "module example.com/m // 模块路径",
          "",
          "go 1.21",
          "",
          "require (",
          "\texample.com/dep v1.2.3",
          "\texample.com/other v0.1.0 // indirect",
          ")",
          "",
          "replace example.com/dep => ../dep",
          "",
          "exclude example.com/bad v1.0.0",
          "",
        ].join("\n"),
        "main.go": "package main\n",
        "util/helper.go": "package util\n",
        "util/helper_test.go": "package util\n",
      });
      expect(resolved(root, "main.go", "example.com/m/util", goModuleResolver)).toEqual([join(root, "util/helper.go").replace(/\\/g, "/")]);
      expect(resolved(root, "main.go", "example.com/other", goModuleResolver)).toEqual([]);
    });
  });

  it("keeps tracking blocks so a `module` line inside a block is not a declaration", async () => {
    await withTemporaryDirectory("go-mod-block", (root) => {
      write(root, {
        "go.mod": ["require (", "\tmodule example.com/not-a-directive", ")", ""].join("\n"),
        "main.go": "package main\n",
        "util/helper.go": "package util\n",
      });
      expect(resolved(root, "main.go", "example.com/not-a-directive/util", goModuleResolver)).toEqual([]);
    });
  });

  it("still reads a module directive that appears after a closed block, and accepts quoted paths", async () => {
    await withTemporaryDirectory("go-mod-after-block", (root) => {
      write(root, {
        "go.mod": ["go 1.21", "", "require (", "\texample.com/dep v1.2.3", ")", "", 'module "example.com/quoted"', ""].join("\n"),
        "main.go": "package main\n",
        "util/helper.go": "package util\n",
      });
      expect(resolved(root, "main.go", "example.com/quoted/util", goModuleResolver)).toEqual([join(root, "util/helper.go").replace(/\\/g, "/")]);
    });
  });

  it("resolves non-test .go files in a package dir, a subpackage, and normalizes separators", async () => {
    await withTemporaryDirectory("go-mod-seam", (root) => {
      write(root, {
        "go.mod": ["module example.com/m", "", "go 1.21", ""].join("\n"),
        "pkg/b.go": "package pkg\n",
        "pkg/a.go": "package pkg\n",
        "pkg/a_test.go": "package pkg\n",
        "pkg/README.md": "not Go\n",
        "pkg/sub/deep.go": "package sub\n",
        "outside.go": "package outside\n",
      });
      const pkg = resolved(root, "pkg/a.go", "example.com/m/pkg", goModuleResolver);
      // 只收 .go 文件、排除 _test.go 与非 Go 文件；结果按路径排序（b.go 先写入也不影响顺序）。
      expect(pkg).toEqual([
        join(root, "pkg/a.go").replace(/\\/g, "/"),
        join(root, "pkg/b.go").replace(/\\/g, "/"),
      ]);
      expect(pkg.every((file) => !file.includes("\\"))).toBe(true);
      // 子包按相对目录解析，不跨目录聚合。
      expect(resolved(root, "pkg/a.go", "example.com/m/pkg/sub", goModuleResolver)).toEqual([join(root, "pkg/sub/deep.go").replace(/\\/g, "/")]);
      // module 根路径本身（relativeDir 为空）解析到模块根目录。
      expect(resolved(root, "pkg/a.go", "example.com/m", goModuleResolver)).toEqual([join(root, "outside.go").replace(/\\/g, "/")]);
    });
  });

  it("returns an empty list for out-of-module sources and for a missing package dir", async () => {
    await withTemporaryDirectory("go-mod-outside", (root) => {
      write(root, {
        "go.mod": ["module example.com/m", ""].join("\n"),
        "pkg/a.go": "package pkg\n",
        "util/helper.go": "package util\n",
      });
      // 模块外（含同前缀但不同段的路径）：必须为空，而不是"没有依赖"以外的任何解释。
      expect(resolved(root, "pkg/a.go", "example.com/other/util", goModuleResolver)).toEqual([]);
      expect(resolved(root, "pkg/a.go", "example.com/mx/util", goModuleResolver)).toEqual([]);
      // 模块内但没有对应目录：空列表。
      expect(resolved(root, "pkg/a.go", "example.com/m/absent", goModuleResolver)).toEqual([]);
    });
  });

  it("keeps a trailing `//` comment out of the module path used for resolution", async () => {
    await withTemporaryDirectory("go-mod-comment", (root) => {
      write(root, {
        "go.mod": ["module example.com/m // 模块路径", ""].join("\n"),
        "pkg/a.go": "package pkg\n",
      });
      // 行注释截断发生在前：`//` 之后不能进入 module 路径（否则源路径前缀永远匹配不上）。
      expect(resolved(root, "pkg/a.go", "example.com/m/pkg", goModuleResolver)).toEqual([join(root, "pkg/a.go").replace(/\\/g, "/")]);
    });
  });

  it("reports unavailable instead of guessing when the file cannot be proven", async () => {
    const cases: Readonly<Record<string, string>> = {
      "unclosed block": ["module example.com/m", "", "require (", "\texample.com/dep v1.2.3"].join("\n"),
      "block comment": ["module example.com/m", "/* 未闭合", ""].join("\n"),
      "duplicated module": ["module example.com/a", "module example.com/b", ""].join("\n"),
      "malformed module": ["module example.com/a example.com/b", ""].join("\n"),
      "no module directive": ["go 1.21", "", "require example.com/dep v1.2.3", ""].join("\n"),
      "module beyond the bounded scan": `${Array.from({ length: GO_MOD_SCAN_MAX_LINES }, () => "// filler").join("\n")}\nmodule example.com/late\n`,
    };
    for (const [name, manifest] of Object.entries(cases)) {
      await withTemporaryDirectory(`go-mod-${name.replace(/\s+/gu, "-")}`, (root) => {
        write(root, { "go.mod": manifest, "main.go": "package main\n", "util/helper.go": "package util\n" });
        expect(resolved(root, "main.go", "example.com/m/util", goModuleResolver), name).toEqual([]);
      });
    }
  });
});

describe("rustModuleResolver（Cargo.toml 用 smol-toml 解析）", () => {
  it("resolves crate-local modules when `[package]` is a real TOML table", async () => {
    await withTemporaryDirectory("cargo-package", (root) => {
      write(root, {
        "Cargo.toml": '[package]\nname = "fixture"\nversion = "0.1.0"\n',
        "src/lib.rs": "pub mod format;\n",
        "src/format.rs": "pub struct Buf;\n",
        "src/util/mod.rs": "pub fn helper() {}\n",
      });
      expect(resolved(root, "src/lib.rs", "crate::format", rustModuleResolver)).toEqual([join(root, "src/format.rs").replace(/\\/g, "/")]);
      expect(resolved(root, "src/lib.rs", "crate::util", rustModuleResolver)).toEqual([join(root, "src/util/mod.rs").replace(/\\/g, "/")]);
    });
  });

  it("is not fooled by `[package]` appearing inside a TOML string", async () => {
    await withTemporaryDirectory("cargo-string", (root) => {
      write(root, {
        "Cargo.toml": '[workspace]\nmembers = ["member"]\ndescription = "[package]"\n',
        "src/lib.rs": "pub mod format;\n",
        "src/format.rs": "pub struct Buf;\n",
      });
      // 旧实现 `/\[package\]/.test(manifest)` 会命中字符串并建立上下文（误判）；解析结果不会。
      expect(resolved(root, "src/lib.rs", "crate::format", rustModuleResolver)).toEqual([]);
    });
  });

  it("treats an unparsable manifest as unavailable, never as a crate without dependencies", async () => {
    await withTemporaryDirectory("cargo-broken", (root) => {
      write(root, {
        // 文本里确实有 `[package]`，但 TOML 语法错误（字符串未闭合）⇒ 不能作为判据。
        "Cargo.toml": '[package]\nname = "broken\n',
        "src/lib.rs": "pub mod format;\n",
        "src/format.rs": "pub struct Buf;\n",
      });
      expect(resolved(root, "src/lib.rs", "crate::format", rustModuleResolver)).toEqual([]);
    });
  });

  it("keeps the existing source-dir condition and accepts the dotted-key package form", async () => {
    await withTemporaryDirectory("cargo-shapes", (root) => {
      write(root, {
        "Cargo.toml": '[package]\nname = "no-src"\nversion = "0.1.0"\n',
        "lib.rs": "pub mod format;\n",
      });
      expect(resolved(root, "lib.rs", "crate::format", rustModuleResolver)).toEqual([]);
    });
    await withTemporaryDirectory("cargo-dotted", (root) => {
      write(root, {
        // `package.name` 与 `[package]\nname` 在 TOML 数据模型上等价 ⇒ 结构判定应当相同。
        "Cargo.toml": 'package.name = "dotted"\npackage.version = "0.1.0"\n',
        "src/lib.rs": "pub mod format;\n",
        "src/format.rs": "pub struct Buf;\n",
      });
      expect(resolved(root, "src/lib.rs", "crate::format", rustModuleResolver)).toEqual([join(root, "src/format.rs").replace(/\\/g, "/")]);
    });
  });
});
