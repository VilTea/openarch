import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectProjectLanguages, nestedLanguageIndicators } from "../src/languageSupport";
import { withTemporaryDirectory } from "./support/temporaryDirectory";

/**
 * D-G11a（2026-09-25 项目所有者批准）：语言自动探测只看**项目根**的构建标记，
 * 而 `openarch-java-guide` 的 `pom.xml` 只在 `complete/`、`initial/` 下 ⇒ 探测到 0 种语言
 * ⇒ 可发现测试文件 0（实际 2 个）。已验证"声明 languages 后递归扫描完全正常"，
 * 因此这只补**提示**，不改写 `languages`（改了会改变 extensions ⇒ 进入 scope 指纹）。
 */
describe("nestedLanguageIndicators（子目录构建标记提示）", () => {
  const seedGuide = (cwd: string): void => {
    for (const [directory, marker] of [["complete", "pom.xml"], ["initial", "pom.xml"], ["complete-kotlin", "build.gradle.kts"]]) {
      mkdirSync(join(cwd, directory!), { recursive: true });
      writeFileSync(join(cwd, directory!, marker!), "<project/>\n");
    }
  };

  it("reports build markers one level down when the language is not covered", () =>
    withTemporaryDirectory("nested-indicators", (cwd) => {
      seedGuide(cwd);
      expect(detectProjectLanguages(cwd)).toEqual([]);
      expect(nestedLanguageIndicators(cwd, [])).toEqual([
        { language: "java", indicator: "pom.xml", directory: "complete" },
        { language: "java", indicator: "build.gradle.kts", directory: "complete-kotlin" },
        { language: "java", indicator: "pom.xml", directory: "initial" },
      ]);
    }));

  it("stays silent once the language is covered, and never changes detected languages", () =>
    withTemporaryDirectory("nested-indicators-covered", (cwd) => {
      seedGuide(cwd);
      expect(nestedLanguageIndicators(cwd, ["java"])).toEqual([]);
      // 提示是纯观察：探测结果不因提示而改变
      expect(detectProjectLanguages(cwd)).toEqual([]);
    }));

  it("skips excluded directories and depths below one level", () =>
    withTemporaryDirectory("nested-indicators-excluded", (cwd) => {
      mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(cwd, "node_modules", "pkg", "pom.xml"), "<project/>\n");
      mkdirSync(join(cwd, "apps", "api"), { recursive: true });
      writeFileSync(join(cwd, "apps", "api", "pom.xml"), "<project/>\n");
      expect(nestedLanguageIndicators(cwd, [])).toEqual([]);
    }));
});
