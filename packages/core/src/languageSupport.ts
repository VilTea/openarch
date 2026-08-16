import { existsSync, readdirSync } from "node:fs";
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
