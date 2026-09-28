import { describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAnalyzableProjectFile, listProjectSourceFiles, readProjectFileKindRules, readProjectLanguageState, readProjectLanguages, sourceSnapshotSha256, configSnapshotSha256 } from "../src/projectFiles";
import { classifyFileKindWithPolicy } from "../src/domain/testGovernance";
import { createAnalysisScope } from "../src/domain/analysisScope";
import { withTemporaryDirectory } from "./support/temporaryDirectory";

/**
 * D-G5（2026-09-25 实地核实，`.research/openarch-java-junit`）：Java 布局优先。
 * 缺陷：`classifyFileKind` 只看文件名后缀，把 `src/main/java` 下的**生产**文件
 * （JUnit 自己的 `org/junit/Test.java` 注解定义等 4 个）算进了测试总体。
 * 修法不是给默认分类器加分支，而是注入**布局推导规则**——这样分类语义的变化会进入
 * `createAnalysisScope` 的指纹，受影响的 baseline 会如实变成 `baseline_scope_incompatible`。
 */
describe("Java 布局推导的文件分类规则", () => {
  const seedJavaProject = (cwd: string, options: { readonly testTree: boolean }): void => {
    mkdirSync(join(cwd, "src", "main", "java", "org", "junit"), { recursive: true });
    writeFileSync(join(cwd, "src", "main", "java", "org", "junit", "Test.java"), "package org.junit;\npublic @interface Test {}\n");
    writeFileSync(join(cwd, "src", "main", "java", "org", "junit", "RepeatedTest.java"), "package org.junit;\npublic class RepeatedTest {}\n");
    writeFileSync(join(cwd, "src", "main", "java", "Widget.java"), "public class Widget {}\n");
    writeFileSync(join(cwd, "pom.xml"), "<project/>\n");
    if (!options.testTree) return;
    mkdirSync(join(cwd, "src", "test", "java", "org", "junit"), { recursive: true });
    writeFileSync(join(cwd, "src", "test", "java", "org", "junit", "RealTest.java"), "package org.junit;\nclass RealTest {}\n");
  };

  it("存在 src/test/java 时，src/main/java 下的生产文件一律算 production", () => withTemporaryDirectory("file-kind-java", (cwd) => {
    seedJavaProject(cwd, { testTree: true });
    const rules = readProjectFileKindRules(cwd);
    const kindOf = (path: string) => classifyFileKindWithPolicy(path, rules, { projectRoot: cwd });
    // 缺陷现场：`org/junit/Test.java`（注解定义）曾被后缀规则吞成 test
    expect(kindOf("src/main/java/org/junit/Test.java")).toBe("production");
    expect(kindOf("src/main/java/org/junit/RepeatedTest.java")).toBe("production");
    expect(kindOf("src/main/java/Widget.java")).toBe("production");
    // 测试树与真实测试文件不受影响
    expect(kindOf("src/test/java/org/junit/RealTest.java")).toBe("test");
    expect(kindOf("src/test/java/org/junit/WidgetTest.java")).toBe("test");
  }));

  it("只有 src/main/java（把测试放在 main 树）时不夺走测试身份", () => withTemporaryDirectory("file-kind-java-main-only", (cwd) => {
    seedJavaProject(cwd, { testTree: false });
    const rules = readProjectFileKindRules(cwd);
    expect(classifyFileKindWithPolicy("src/main/java/org/junit/Test.java", rules, { projectRoot: cwd })).toBe("test");
  }));

  it("项目显式 file_kinds 规则优先于布局推导规则", () => withTemporaryDirectory("file-kind-java-policy", (cwd) => {
    mkdirSync(join(cwd, ".openarch"), { recursive: true });
    mkdirSync(join(cwd, "src", "main", "java"), { recursive: true });
    mkdirSync(join(cwd, "src", "test", "java"), { recursive: true });
    writeFileSync(join(cwd, ".openarch", "config.yml"), [
      "languages: [java]", "file_kinds:", "  - pattern: \"src/main/java/generated/**\"", "    kind: generated", "",
    ].join("\n"));
    const rules = readProjectFileKindRules(cwd);
    expect(rules[0]).toEqual({ pattern: "src/main/java/generated/**", kind: "generated" });
    expect(classifyFileKindWithPolicy("src/main/java/generated/ApiTest.java", rules, { projectRoot: cwd })).toBe("generated");
    expect(classifyFileKindWithPolicy("src/main/java/other/ApiTest.java", rules, { projectRoot: cwd })).toBe("production");
  }));

  it("布局规则进入分析范围指纹：语义变化不会被静默继承", () => withTemporaryDirectory("file-kind-java-scope", (cwd) => {
    seedJavaProject(cwd, { testTree: true });
    const withLayout = createAnalysisScope(["java"], readProjectFileKindRules(cwd));
    const withoutLayout = createAnalysisScope(["java"], []);
    expect(withLayout.fingerprint).not.toBe(withoutLayout.fingerprint);
    // 推导规则只影响该布局，其他语言/无该布局的项目指纹不变
    expect(createAnalysisScope(["go"], [])).toEqual(createAnalysisScope(["go"], []));
  }));
});

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

  it("无 projectIndicators 的 TS/Vue 项目按源码扩展名回退检测", () => withTemporaryDirectory("project-files", (cwd) => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "main.ts"), "export const main = true;\n");
    writeFileSync(join(cwd, "src", "App.vue"), "<script>export default {};</script>\n");

    expect(readProjectLanguages(cwd)).toEqual(["typescript", "vue"]);
    expect(listProjectSourceFiles({ cwd, population: "production-governance" })).toEqual([
      join(cwd, "src", "App.vue"),
      join(cwd, "src", "main.ts"),
    ]);
  }));

  it("构建与依赖目录是固定扫描边界，不能重新纳入", () => withTemporaryDirectory("project-files", (cwd) => {
    mkdirSync(join(cwd, ".openarch"), { recursive: true });
    for (const directory of ["src", "target", "build", ".venv", "node_modules"]) {
      mkdirSync(join(cwd, directory), { recursive: true });
    }
    writeFileSync(join(cwd, ".openarch", "config.yml"), 'languages: ["typescript"]\n');
    writeFileSync(join(cwd, "src", "main.ts"), "export const main = true;\n");
    for (const directory of ["target", "build", ".venv", "node_modules"]) {
      writeFileSync(join(cwd, directory, "generated.ts"), "export const generated = true;\n");
    }

    expect(listProjectSourceFiles({ cwd })).toEqual([join(cwd, "src", "main.ts")]);
  }));

  it("symlink 别名去重，保留真实路径", () => withTemporaryDirectory("project-files", (cwd) => {
    mkdirSync(join(cwd, ".openarch"), { recursive: true });
    writeFileSync(join(cwd, ".openarch", "config.yml"), 'languages: ["typescript"]\n');
    mkdirSync(join(cwd, "real"), { recursive: true });
    writeFileSync(join(cwd, "real", "lib.ts"), "export const lib = true;\n");
    try {
      symlinkSync(join(cwd, "real"), join(cwd, "alias"), "dir");
    } catch {
      return; // 无符号链接权限时跳过该平台断言
    }
    expect(listProjectSourceFiles({ cwd })).toEqual([join(cwd, "real", "lib.ts")]);
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
