import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAnalyzableProjectFile, listProjectSourceFiles, readProjectLanguageState, readProjectLanguages, sourceSnapshotSha256, configSnapshotSha256 } from "../src/projectFiles";
import { withTemporaryDirectory } from "./support/temporaryDirectory";

describe("projectFiles", () => {
  it("未初始化但存在 go.mod 时，按项目探测返回 go", () => withTemporaryDirectory("project-files", (cwd) => {
    writeFileSync(join(cwd, "go.mod"), "module example.com/demo\n\ngo 1.26.0\n");

    expect(readProjectLanguages(cwd)).toEqual(["go"]);
  }));

  it("检测 Cargo 项目与 Rust 源码", () => withTemporaryDirectory("project-files", (cwd) => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "Cargo.toml"), "[package]\nname = 'example'\nversion = '0.1.0'\n");
    writeFileSync(join(cwd, "src", "lib.rs"), "pub fn library() {}\n");

    expect(readProjectLanguages(cwd)).toEqual(["rust"]);
    expect(listProjectSourceFiles({ cwd })).toEqual([join(cwd, "src", "lib.rs")]);
  }));

  it("检测 Python 项目与源码", () => withTemporaryDirectory("project-files", (cwd) => {
    writeFileSync(join(cwd, "pyproject.toml"), "[project]\nname = 'example'\n");
    writeFileSync(join(cwd, "main.py"), "def main(): pass\n");

    expect(readProjectLanguages(cwd)).toEqual(["python"]);
    expect(listProjectSourceFiles({ cwd })).toEqual([join(cwd, "main.py")]);
  }));

  it("configSnapshotSha256 反映 config.yml 内容变化", () => withTemporaryDirectory("project-files", (cwd) => {
    const cfg = join(cwd, "config.yml");
    writeFileSync(cfg, "languages: [javascript]\n");
    const first = configSnapshotSha256(cfg);
    expect(first).toBeTruthy();
    writeFileSync(cfg, "languages: [javascript]\nstructural_policies:\n  - id: demo\n");
    expect(configSnapshotSha256(cfg)).not.toBe(first);
  }));

  it("configSnapshotSha256 对缺失文件返回 undefined", () => withTemporaryDirectory("project-files", (cwd) => {
    expect(configSnapshotSha256(join(cwd, "missing.yml"))).toBeUndefined();
  }));

  it("未知项目保持空作用域，而不是回退到 TypeScript", () => withTemporaryDirectory("project-files", (cwd) => {
    writeFileSync(join(cwd, "project.unknown"), "example\n");

    expect(readProjectLanguages(cwd)).toEqual([]);
    expect(listProjectSourceFiles({ cwd })).toEqual([]);
  }));

  it("按配置语言扫描任意项目结构，而不是写死 packages 目录", () => withTemporaryDirectory("project-files", (cwd) => {
    mkdirSync(join(cwd, ".openarch"), { recursive: true });
    mkdirSync(join(cwd, "cmd"), { recursive: true });
    mkdirSync(join(cwd, "tools"), { recursive: true });
    mkdirSync(join(cwd, "web"), { recursive: true });
    mkdirSync(join(cwd, "vendor", "dep"), { recursive: true });
    mkdirSync(join(cwd, "dist"), { recursive: true });
    mkdirSync(join(cwd, "__tests__"), { recursive: true });

    writeFileSync(join(cwd, ".openarch", "config.yml"), 'languages: ["go", "javascript"]\n');
    writeFileSync(join(cwd, "cmd", "main.go"), "package main\nfunc main() {}\n");
    writeFileSync(join(cwd, "web", "app.jsx"), "export const App = () => null;\n");
    writeFileSync(join(cwd, "tools", "release.mjs"), "export const release = () => null;\n");
    writeFileSync(join(cwd, "tools", "legacy.cjs"), "module.exports = {};\n");
    writeFileSync(join(cwd, "__tests__", "app.test.jsx"), "it('x', () => {})\n");
    writeFileSync(join(cwd, "cmd", "main_test.go"), "package main\nfunc TestMain() {}\n");
    writeFileSync(join(cwd, "dist", "bundle.js"), "console.log('dist')\n");
    writeFileSync(join(cwd, "vendor", "dep", "dep.go"), "package dep\n");
    writeFileSync(join(cwd, "notes.ts"), "export const ignored = true;\n");

    expect(listProjectSourceFiles({ cwd, population: "production-governance" })).toEqual([
      join(cwd, "cmd", "main.go"),
      join(cwd, "tools", "legacy.cjs"),
      join(cwd, "tools", "release.mjs"),
      join(cwd, "web", "app.jsx"),
    ]);

    expect(listProjectSourceFiles({ cwd, population: "observed" })).toEqual([
      join(cwd, "__tests__", "app.test.jsx"),
      join(cwd, "cmd", "main.go"),
      join(cwd, "cmd", "main_test.go"),
      join(cwd, "tools", "legacy.cjs"),
      join(cwd, "tools", "release.mjs"),
      join(cwd, "web", "app.jsx"),
    ]);
  }));

  it("按项目 file_kinds 规则排除 auxiliary 文件，而不是要求产品内置目录约定", () => withTemporaryDirectory("project-files", (cwd) => {
    mkdirSync(join(cwd, ".openarch"), { recursive: true });
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(cwd, "samples"), { recursive: true });

    writeFileSync(join(cwd, ".openarch", "config.yml"), 'languages: ["typescript"]\nfile_kinds:\n  - pattern: "samples/**"\n    kind: "auxiliary"\n');
    writeFileSync(join(cwd, "src", "main.ts"), "export const main = true;\n");
    writeFileSync(join(cwd, "samples", "demo.ts"), "export const demo = true;\n");

    expect(listProjectSourceFiles({ cwd, population: "production-governance" })).toEqual([
      join(cwd, "src", "main.ts"),
    ]);

    expect(listProjectSourceFiles({ cwd, population: "observed" })).toEqual([
      join(cwd, "samples", "demo.ts"),
      join(cwd, "src", "main.ts"),
    ]);
  }));

  it("拒绝显式项目外源码和跨边界 source snapshot", () => withTemporaryDirectory("project-files", (cwd) => withTemporaryDirectory("project-files-outside", (outside) => {
    const path = join(outside, "outside.ts");
    writeFileSync(path, "export const outside = true;\n");
    expect(isAnalyzableProjectFile(path, { cwd, languages: ["typescript"] })).toBe(false);
    expect(sourceSnapshotSha256([path], cwd)).toBeUndefined();
  })));

  it("readProjectLanguageState 区分显式配置与指示文件检测（hook 提醒依据）", () => withTemporaryDirectory("project-files", (cwd) => {
    mkdirSync(join(cwd, ".openarch"), { recursive: true });
    writeFileSync(join(cwd, "go.mod"), "module example.com/demo\n\ngo 1.26.0\n");

    // 已初始化但未声明 languages：configured 空、detected=go、configExists=true
    writeFileSync(join(cwd, ".openarch", "config.yml"), "# no languages\n");
    expect(readProjectLanguageState(cwd)).toEqual({ configured: undefined, detected: ["go"], configExists: true });

    // 显式声明后：configured 优先
    writeFileSync(join(cwd, ".openarch", "config.yml"), "languages: [\"rust\"]\n");
    expect(readProjectLanguageState(cwd)).toEqual({ configured: ["rust"], detected: ["go"], configExists: true });
    expect(readProjectLanguages(cwd)).toEqual(["rust"]);

    // 未初始化：configExists=false，回退检测
    withTemporaryDirectory("project-files-bare", (bare) => {
      writeFileSync(join(bare, "go.mod"), "module example.com/demo\n");
      expect(readProjectLanguageState(bare)).toEqual({ configured: undefined, detected: ["go"], configExists: false });
    });
  }));
});
