import type { Language } from "../domain/ast";

type SupportMatcher = (path: string) => boolean;

const basename = (path: string): string => path.split("/").at(-1) ?? path;

const exact = (...names: readonly string[]): SupportMatcher => (path) => names.includes(path) || names.includes(basename(path));

const typeScriptSupport = (path: string): boolean =>
  /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/i.test(path) || exact("package.json")(path);

const languageSupport: Readonly<Record<Language, SupportMatcher>> = {
  typescript: typeScriptSupport,
  javascript: typeScriptSupport,
  vue: typeScriptSupport,
  python: exact("pyrightconfig.json", "pyproject.toml"),
  go: exact("go.mod", "go.sum", "go.work"),
  rust: exact("Cargo.toml", "Cargo.lock"),
  java: exact("pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"),
};

/**
 * Declarative support-file manifest for a bounded historical workspace. It
 * records language tooling inputs without teaching the snapshot collector any
 * provider implementation details.
 */
export const symbolRevisionSupportPaths = (
  languages: readonly Language[],
  paths: readonly string[],
): readonly string[] => {
  const matchers = [...new Set(languages)].map((language) => languageSupport[language]);
  return paths.filter((path) => path === ".openarch/config.yml" || matchers.some((matcher) => matcher(path)));
};

export const isTypeScriptRevisionConfig = (path: string): boolean =>
  /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/i.test(path);
