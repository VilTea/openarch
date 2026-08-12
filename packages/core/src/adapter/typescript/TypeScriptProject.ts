import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { toPosixPath } from "../../infra/paths";

export interface TypeScriptProject {
  readonly configPath: string;
  readonly parsed: ts.ParsedCommandLine;
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly sources: readonly ts.SourceFile[];
}

export const normalizeTypeScriptPath = (path: string): string => toPosixPath(path);

export const aliasTypeScriptSymbol = (checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined =>
  symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;

export const typeScriptConfigPathFor = (path: string): string | undefined =>
  ts.findConfigFile(dirname(path), ts.sys.fileExists, "tsconfig.json") ?? undefined;

const projectForConfig = (
  cwd: string,
  configPath: string,
  governedSourcePaths: ReadonlySet<string>,
): TypeScriptProject | undefined => {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) return undefined;
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), undefined, configPath);
  const host = ts.createCompilerHost(parsed.options);
  // Preserve source identity across referenced projects instead of treating
  // their emitted declarations as unrelated external symbols.
  (host as ts.CompilerHost & { useSourceOfProjectReferenceRedirect: () => boolean })
    .useSourceOfProjectReferenceRedirect = () => true;
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    host,
    projectReferences: parsed.projectReferences,
  });
  const root = normalizeTypeScriptPath(resolve(cwd));
  return {
    configPath,
    parsed,
    program,
    checker: program.getTypeChecker(),
    // The compiler program may contain generated or sibling-package sources.
    // Consumers only make repository coverage claims for the configured scope.
    sources: program.getSourceFiles().filter((source) =>
      !source.isDeclarationFile
      && normalizeTypeScriptPath(resolve(source.fileName)).startsWith(`${root}/`)
      && governedSourcePaths.has(normalizeTypeScriptPath(resolve(source.fileName)))),
  };
};

/**
 * Builds one compiler project for every tsconfig that governs configured
 * TypeScript source. This is intentionally source-led: monorepo layout is not
 * inferred from directory names or package-manager conventions.
 */
export const loadTypeScriptProjects = (cwd: string, sourceFiles: readonly string[]): readonly TypeScriptProject[] => {
  const governedSourcePaths = new Set(sourceFiles.map((file) => normalizeTypeScriptPath(resolve(file))));
  const configPaths = new Set(sourceFiles.flatMap((file) => {
    const configPath = typeScriptConfigPathFor(file);
    return configPath ? [configPath] : [];
  }));
  if (configPaths.size === 0) {
    const rootConfig = ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
    if (rootConfig) configPaths.add(rootConfig);
  }
  return [...configPaths]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((configPath) => {
      const project = projectForConfig(cwd, configPath, governedSourcePaths);
      return project ? [project] : [];
    });
};

/** A compiler report is complete only if every governed source was included by a readable project. */
export const hasCompleteTypeScriptProjectScope = (
  projects: readonly TypeScriptProject[],
  sourceFiles: readonly string[],
): boolean => {
  const loaded = new Set(projects.flatMap((project) => project.sources)
    .map((source) => normalizeTypeScriptPath(resolve(source.fileName))));
  return sourceFiles.every((file) => loaded.has(normalizeTypeScriptPath(resolve(file))));
};

export const relativeTypeScriptPath = (cwd: string, path: string): string => normalizeTypeScriptPath(relative(cwd, path));
