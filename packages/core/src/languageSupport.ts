import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import {
  LANGUAGE_SUPPORTS,
  detectProjectLanguages as detectFromRegistry,
  extensionsForLanguages,
  findLanguageForFile,
  supportForLanguage,
  supportedLanguageIds,
  type LanguageSupport,
} from "./adapter/parser/LanguageRegistry";
import type { Language } from "./domain/ast";
import { SCAN_EXCLUDED_DIRECTORY_NAMES } from "./infra/scanExclusions";

export { LANGUAGE_SUPPORTS, extensionsForLanguages, findLanguageForFile, supportForLanguage, supportedLanguageIds };
export type { LanguageSupport };

const SOURCE_FALLBACK_DEPTH = 8;

/** TS/JS/Vue 没有 projectIndicators，必须按真实源码扩展名回退检测
 *  （校准 2026-08-15：vue2/vue3 探针曾因无显式标记而 scan=0）。 */
const findFirstSourceFile = (
  directory: string,
  extensions: readonly string[],
  depth: number,
): boolean => {
  if (depth <= 0 || !existsSync(directory)) return false;
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SCAN_EXCLUDED_DIRECTORY_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
      if (findFirstSourceFile(join(directory, entry.name), extensions, depth - 1)) return true;
      continue;
    }
    if (extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))) return true;
  }
  return false;
};

export const detectProjectLanguages = (cwd: string): readonly Language[] => {
  const indicatorLanguages = detectFromRegistry(cwd, existsSync, join);
  const sourceLanguages = LANGUAGE_SUPPORTS
    .filter((language) => !(language.projectIndicators?.length))
    .flatMap((language) =>
      findFirstSourceFile(cwd, language.extensions, SOURCE_FALLBACK_DEPTH) ? [language.id] : [],
    );
  return [...new Set([...indicatorLanguages, ...sourceLanguages])];
};

/** 子目录里的构建标记（提示用，**不是**语言事实）。 */
export interface NestedLanguageIndicator {
  readonly language: Language;
  readonly indicator: string;
  /** 项目根相对目录名（不含末尾分隔符）。 */
  readonly directory: string;
}

/**
 * D-G11a（2026-09-25 项目所有者批准）：**子目录**里的构建标记**提示**。
 *
 * 缺陷现场（`.research/openarch-java-guide`）：`pom.xml` 只在 `complete/`、`initial/` 下，
 * 而 `detectProjectLanguages` 只查项目根 ⇒ 探测到 0 种语言 ⇒ 可发现测试文件 0（实际有 2 个）。
 * 直接探针确认：**声明 `languages: [java]` 后递归扫描完全正常**，所以这不是覆盖率漏洞，
 * 而是"自动探测只看根目录"的便利性缺口。
 *
 * 因此本函数**只产生提示**：不改 `languages`（改了会改变 `extensions` ⇒ 进入
 * `createAnalysisScope` 指纹 ⇒ 受影响项目的 baseline 失效），也不参与任何判据。
 *
 * 边界（有意记录）：只下探**一层**（`complete/pom.xml` 这类多模块布局的常见形态），
 * 且只报**当前未被覆盖**的语言（`covered`）；深于一层、或已声明的语言不提示，避免噪声。
 * 返回按 directory+language 去重。
 */
export const nestedLanguageIndicators = (
  cwd: string,
  covered: readonly string[] = [],
): readonly NestedLanguageIndicator[] => {
  const coveredSet = new Set(covered);
  let entries: readonly Dirent[];
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: NestedLanguageIndicator[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory() || SCAN_EXCLUDED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) continue;
    for (const support of LANGUAGE_SUPPORTS) {
      if (coveredSet.has(support.id)) continue;
      const indicator = (support.projectIndicators ?? []).find((candidate) => existsSync(join(cwd, entry.name, candidate)));
      if (indicator === undefined) continue;
      const key = `${entry.name}\u0000${support.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ language: support.id, indicator, directory: entry.name });
    }
  }
  return found.sort((left, right) => left.directory.localeCompare(right.directory) || left.language.localeCompare(right.language));
};
