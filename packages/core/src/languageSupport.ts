import { existsSync } from "node:fs";
import { join } from "node:path";
export { LANGUAGE_SUPPORTS, extensionsForLanguages, findLanguageForFile, supportForLanguage, supportedLanguageIds } from "./adapter/parser/LanguageRegistry";
export type { LanguageSupport } from "./adapter/parser/LanguageRegistry";
import { detectProjectLanguages as detectFromRegistry } from "./adapter/parser/LanguageRegistry";

export const detectProjectLanguages = (cwd: string) => detectFromRegistry(cwd, existsSync, join);
