import { Effect } from "effect";
import type { FileAst, Language } from "../../domain/ast";
import type { InvocationBindingFact } from "../../domain/invocationBindings";
import type { QueryMatch } from "../../port/ParserService";
import { ParseError } from "../../errors/errors";
import { invocationBindingsGo, parseGo, parseGoText, queryGo } from "./GoStrategy";
import { invocationBindingsJava, parseJava, parseJavaText, queryJava } from "./JavaStrategy";
import { invocationBindingsPython, parsePython, parsePythonText, queryPython } from "./PythonStrategy";
import { invocationBindingsRust, parseRust, parseRustText, queryRust } from "./RustStrategy";
import { invocationBindingsTs, parseTs, parseTsText, queryTs, parseVue, parseVueText, queryVue, invocationBindingsVue } from "./TsStrategy";

export interface ParserStrategy {
  readonly parse: (path: string) => Effect.Effect<FileAst, ParseError>;
  readonly parseText: (path: string, text: string) => Effect.Effect<FileAst, ParseError>;
  readonly query: (path: string, pattern: string) => Effect.Effect<QueryMatch[], ParseError>;
  readonly invocationBindings?: (path: string) => Effect.Effect<readonly InvocationBindingFact[], ParseError>;
}

export interface LanguageSupport {
  readonly id: Language;
  readonly extensions: readonly string[];
  readonly projectIndicators?: readonly string[];
}

interface LanguageRegistration extends LanguageSupport {
  readonly strategy: ParserStrategy;
}

const tsFamilyStrategy = (language: "typescript" | "javascript"): ParserStrategy => ({
  parse: (path) => parseTs(path, language),
  parseText: (path, text) => parseTsText(path, text, language),
  query: queryTs,
  invocationBindings: invocationBindingsTs,
});

/** vue SFC：提取 <script> 块后按 javascript 语义分析（行号对齐保留源文件行号）。 */
const vueStrategy: ParserStrategy = {
  parse: parseVue,
  parseText: parseVueText,
  query: queryVue,
  invocationBindings: invocationBindingsVue,
};

const goStrategy: ParserStrategy = { parse: parseGo, parseText: parseGoText, query: queryGo, invocationBindings: invocationBindingsGo };
const rustStrategy: ParserStrategy = { parse: parseRust, parseText: parseRustText, query: queryRust, invocationBindings: invocationBindingsRust };
const pythonStrategy: ParserStrategy = { parse: parsePython, parseText: parsePythonText, query: queryPython, invocationBindings: invocationBindingsPython };
const javaStrategy: ParserStrategy = { parse: parseJava, parseText: parseJavaText, query: queryJava, invocationBindings: invocationBindingsJava };

const LANGUAGE_REGISTRATIONS: readonly LanguageRegistration[] = Object.freeze([
  { id: "typescript", extensions: [".ts", ".tsx", ".mts", ".cts"], strategy: tsFamilyStrategy("typescript") },
  { id: "javascript", extensions: [".js", ".jsx", ".mjs", ".cjs"], strategy: tsFamilyStrategy("javascript") },
  { id: "vue", extensions: [".vue"], strategy: vueStrategy },
  { id: "go", extensions: [".go"], projectIndicators: ["go.mod"], strategy: goStrategy },
  { id: "rust", extensions: [".rs"], projectIndicators: ["Cargo.toml"], strategy: rustStrategy },
  { id: "python", extensions: [".py"], projectIndicators: ["pyproject.toml", "setup.py", "setup.cfg"], strategy: pythonStrategy },
  { id: "java", extensions: [".java"], projectIndicators: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"], strategy: javaStrategy },
]);

export const LANGUAGE_SUPPORTS: readonly LanguageSupport[] = LANGUAGE_REGISTRATIONS;

export const supportForLanguage = (language: string): LanguageSupport | undefined =>
  LANGUAGE_REGISTRATIONS.find((entry) => entry.id === language);

export const findLanguageForFile = (path: string): LanguageSupport | undefined => {
  const normalized = path.toLowerCase();
  return LANGUAGE_REGISTRATIONS.find((language) => language.extensions.some((extension) => normalized.endsWith(extension)));
};

export const parserStrategyForFile = (path: string): ParserStrategy | undefined => {
  const normalized = path.toLowerCase();
  return LANGUAGE_REGISTRATIONS.find((language) => language.extensions.some((extension) => normalized.endsWith(extension)))?.strategy;
};

export const extensionsForLanguages = (languages: readonly string[]): readonly string[] =>
  [...new Set(languages.flatMap((language) => supportForLanguage(language)?.extensions ?? []))];

export const supportedLanguageIds = (): readonly Language[] => LANGUAGE_REGISTRATIONS.map((language) => language.id);

export const detectProjectLanguages = (cwd: string, exists: (path: string) => boolean, join: (cwd: string, indicator: string) => string): readonly Language[] =>
  LANGUAGE_REGISTRATIONS
    .filter((language) => (language.projectIndicators ?? []).some((indicator) => exists(join(cwd, indicator))))
    .map((language) => language.id);
