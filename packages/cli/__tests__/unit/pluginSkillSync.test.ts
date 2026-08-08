import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd(), "..", "..");
const developmentSkillRoots = {
  zh: resolve(repositoryRoot, ".agents", "skills", "openarch"),
  en: resolve(repositoryRoot, ".agents", "skills", "openarch-locales", "en"),
} as const;
const runtimeSkillRoot = resolve(repositoryRoot, "packages", "core", "assets", "agent-skills", "openarch", "locales");
const packagedSkillRoot = resolve(repositoryRoot, "packages", "openarch-plugin", "assets", "agent-skills", "openarch", "locales");
const pluginDiscoverySkillRoots = {
  zh: resolve(repositoryRoot, "packages", "openarch-plugin", "skills", "openarch-zh"),
  en: resolve(repositoryRoot, "packages", "openarch-plugin", "skills", "openarch-en"),
} as const;
const legacySkillRoots = [
  resolve(repositoryRoot, "packages", "core", "assets", "agent-skills", "openarch"),
  resolve(repositoryRoot, "packages", "openarch-plugin", "skills", "openarch"),
];

const filesUnder = (root: string, directory = root): readonly string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory()
    ? filesUnder(root, resolve(directory, entry.name))
    : [relative(root, resolve(directory, entry.name)).replace(/\\/g, "/")])
  .sort();

const proseLines = (markdown: string): readonly string[] => {
  let fenced = false;
  let frontmatter = markdown.startsWith("---\n");
  return markdown.split(/\r?\n/).flatMap((line) => {
    if (frontmatter && line === "---") {
      frontmatter = false;
      return [];
    }
    if (frontmatter) return [];
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      return [];
    }
    if (fenced || line.trimStart().startsWith(">")) return [];
    return [line.replace(/`[^`]*`/g, "").replace(/!?(?:\[[^\]]*\])?\([^)]*\)/g, "").trim()];
  }).filter(Boolean);
};

const protocolTerms = /OpenArch|Agent|CI|Git|AST|WASM|Tree-sitter|TypeScript|JavaScript|Python|Pyright|Java|Maven|Gradle|Rust|POSIX|SHA|LOC|LSP|SCIP|API|CVE|SCA/gi;

const englishProseInChineseTree = (markdown: string): readonly string[] => proseLines(markdown)
  .filter((line) => line.replace(protocolTerms, "").match(/[A-Za-z]{3,}(?:\s+[A-Za-z]{3,})+/));

const chineseProseInEnglishTree = (markdown: string): readonly string[] => proseLines(markdown)
  .filter((line) => /[\u3400-\u9fff]/.test(line));

// development 源树（.agents 是 codex 配置位置，仅 main 开发分支有）——release 分支
// 无 .agents，本组 skill 同步校验跳过（发行树自身的对齐由 assets 打包测试覆盖）。
const developmentTreePresent = ["zh", "en"].every((locale) => existsSync(developmentSkillRoots[locale as keyof typeof developmentSkillRoots]));

describe.skipIf(!developmentTreePresent)("published OpenArch skill assets", () => {
  it("keeps each locale's development, runtime, and plugin trees aligned", () => {
    for (const locale of ["zh", "en"] as const) {
      const developmentSkill = developmentSkillRoots[locale];
      const expected = filesUnder(developmentSkill);
      const runtimeSkill = resolve(runtimeSkillRoot, locale);
      const packagedSkill = resolve(packagedSkillRoot, locale);
      expect(filesUnder(runtimeSkill)).toEqual(expected);
      expect(filesUnder(packagedSkill)).toEqual(expected);
      for (const relativePath of expected) {
      const source = resolve(developmentSkill, relativePath);
      const runtime = resolve(runtimeSkill, relativePath);
      const published = resolve(packagedSkill, relativePath);
      expect(existsSync(source), `${relativePath} development asset`).toBe(true);
      expect(existsSync(runtime), `${relativePath} runtime asset`).toBe(true);
      expect(existsSync(published), `${relativePath} packaged asset`).toBe(true);
      expect(readFileSync(published, "utf8")).toBe(readFileSync(runtime, "utf8"));
      expect(readFileSync(runtime, "utf8")).toBe(readFileSync(source, "utf8"));
      }
    }
  });

  it("does not leave a legacy mixed Skill tree beside locale assets", () => {
    for (const root of legacySkillRoots) {
      expect(existsSync(resolve(root, "SKILL.md")), root).toBe(false);
      expect(existsSync(resolve(root, "references")), root).toBe(false);
    }
  });

  it("keeps plugin-discoverable localized Skills complete and independently named", () => {
    for (const locale of ["zh", "en"] as const) {
      const source = developmentSkillRoots[locale];
      const discovery = pluginDiscoverySkillRoots[locale];
      expect(filesUnder(discovery)).toEqual(filesUnder(source));
      expect(readFileSync(resolve(discovery, "SKILL.md"), "utf8")).toContain(`name: openarch-${locale}`);
      for (const relativePath of filesUnder(source).filter((path) => path !== "SKILL.md")) {
        expect(readFileSync(resolve(discovery, relativePath), "utf8")).toBe(readFileSync(resolve(source, relativePath), "utf8"));
      }
    }
  });

  it("keeps language trees monolingual outside protocols and source quotations", () => {
    for (const locale of ["zh", "en"] as const) {
      for (const relativePath of filesUnder(developmentSkillRoots[locale]).filter((path) => path.endsWith(".md"))) {
        const source = readFileSync(resolve(developmentSkillRoots[locale], relativePath), "utf8");
        const violations = locale === "zh" ? englishProseInChineseTree(source) : chineseProseInEnglishTree(source);
        expect(violations, `${locale}/${relativePath}`).toEqual([]);
      }
    }
  });

  it("keeps the constitutional metric compass and route contract in both languages", () => {
    for (const locale of ["zh", "en"] as const) {
      const skill = readFileSync(resolve(developmentSkillRoots[locale], "SKILL.md"), "utf8");
    for (const term of ["实事求是", "信息论", "红军经验", "I_push", "CRL_state", "D_MR", "PARTIAL", "BLOCK"]) {
        if (locale === "zh") expect(skill).toContain(term);
        else expect(skill).toContain(term === "实事求是" ? "Seek truth from facts" : term === "信息论" ? "Information theory" : term === "红军经验" ? "Red Army experience" : term);
      }
      for (const reference of ["metrics-and-evidence.md", "governance-lifecycle.md", "script-authoring.md", "project-defenses.md", "collaboration-and-evolution.md", "language-and-assurance.md", "methodological-sources.md"]) {
        expect(skill).toContain(reference);
      }
    }
    for (const locale of ["zh", "en"] as const) {
      const metrics = readFileSync(resolve(developmentSkillRoots[locale], "references", "metrics-and-evidence.md"), "utf8");
      for (const term of ["λ_ast", "α_struct", "localBurden", "CALIBRATION_SHIFT"]) expect(metrics).toContain(term);
    }
  });
});
