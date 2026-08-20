import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import type { ParserService, QueryCapture, QueryMatch } from "../../port/ParserService";
import type { LspLaunchSpec, LspSession } from "../lsp/NodeLspSession";
import { relationDefinitionLocations, relationLaunch, relationPositionForOffset, relationRepositoryPath } from "./relationLsp";
import { runLspResolutionPipeline, type LspResolutionKernel, type PipelineRuntime } from "./semanticRelationPipeline";
import { captureOf, LSP_REQUEST_TIMEOUT_MS } from "./semanticRelationShared";
import type { SemanticRelationProvider, SemanticRelationRequest } from "../../semantic-relations/provider";
import type { SemanticRelationFact, SemanticRelationReport, SemanticRelationSymbol } from "../../semantic-relations/types";

interface JavaTypeDeclaration {
  readonly file: string;
  readonly name: string;
  readonly kind: "class" | "interface" | "enum";
  readonly startLine: number;
  readonly endLine: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly nameStartLine: number;
  readonly nameStartIndex: number;
  readonly qualifiedName: string;
}

interface RelationCandidate {
  readonly kind: SemanticRelationFact["kind"];
  readonly file: string;
  readonly line: number;
  readonly typeRef: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly source: JavaTypeDeclaration;
}

interface JavaTarget {
  readonly declaration: JavaTypeDeclaration;
  readonly file: string;
}

export interface JavaSemanticRelationRuntime extends PipelineRuntime {
  readonly parser?: ParserService;
}

const NON_REPOSITORY_TYPES = new Set(["byte", "short", "int", "long", "char", "float", "double", "boolean", "void"]);

const DECLARATION_QUERY = `[
  (class_declaration name: (identifier) @name) @classDecl
  (interface_declaration name: (identifier) @name) @interfaceDecl
  (enum_declaration name: (identifier) @name) @enumDecl
  (record_declaration name: (identifier) @name) @recordDecl
]`;

const EXTENDS_QUERY = `[
  (class_declaration name: (identifier) @className superclass: (superclass (_type) @typeRef))
  (interface_declaration name: (identifier) @className (extends_interfaces (type_list (_type) @typeRef)))
]`;

const IMPLEMENTS_QUERY = `[
  (class_declaration name: (identifier) @className interfaces: (super_interfaces (type_list (_type) @typeRef)))
  (enum_declaration name: (identifier) @className interfaces: (super_interfaces (type_list (_type) @typeRef)))
  (record_declaration name: (identifier) @className interfaces: (super_interfaces (type_list (_type) @typeRef)))
]`;

const FIELD_QUERY = `[
  (field_declaration type: (_unannotated_type) @typeRef)
  (constant_declaration type: (_unannotated_type) @typeRef)
]`;

const PARAMETER_QUERY = `[
  (method_declaration parameters: (formal_parameters (formal_parameter type: (_unannotated_type) @typeRef)))
  (constructor_declaration parameters: (formal_parameters (formal_parameter type: (_unannotated_type) @typeRef)))
  (method_declaration parameters: (formal_parameters (spread_parameter (_unannotated_type) @typeRef)))
  (constructor_declaration parameters: (formal_parameters (spread_parameter (_unannotated_type) @typeRef)))
]`;

const RETURN_QUERY = `(method_declaration type: (_unannotated_type) @typeRef)`;

const INSTANTIATE_QUERY = `[
  (object_creation_expression type: (type_identifier) @typeRef)
  (object_creation_expression type: (scoped_type_identifier) @typeRef)
  (object_creation_expression type: (generic_type) @typeRef)
]`;

const packageNameOf = (source: string): string | undefined =>
  /package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/.exec(source)?.[1];

const simpleTypeName = (typeRef: string): string => {
  const withoutBrackets = typeRef.replace(/\[\s*\]/g, "").trim();
  const withoutGenerics = withoutBrackets.replace(/<[\s\S]*>$/, "").trim();
  const segments = withoutGenerics.split(".");
  return (segments[segments.length - 1] ?? withoutGenerics).trim();
};

const isNonRepositoryType = (typeRef: string): boolean => NON_REPOSITORY_TYPES.has(simpleTypeName(typeRef));

const lastIdentifierOffset = (source: string, startIndex: number, endIndex: number): number => {
  const slice = source.slice(startIndex, endIndex)
    .replace(/\[\s*\]/g, "")
    .replace(/<[\s\S]*>$/, "")
    .trimEnd();
  const match = /([A-Za-z_$][\w$]*)\s*$/.exec(slice);
  return match ? startIndex + slice.lastIndexOf(match[1]) : startIndex;
};

const declarationKindOf = (match: QueryMatch): JavaTypeDeclaration["kind"] | undefined => {
  if (captureOf(match, "classDecl") || captureOf(match, "recordDecl")) return "class";
  if (captureOf(match, "interfaceDecl")) return "interface";
  if (captureOf(match, "enumDecl")) return "enum";
  return undefined;
};

const declarationNodeOf = (match: QueryMatch): QueryCapture | undefined =>
  captureOf(match, "classDecl") ?? captureOf(match, "interfaceDecl") ?? captureOf(match, "enumDecl") ?? captureOf(match, "recordDecl");

const withQualifiedNames = (declarations: readonly JavaTypeDeclaration[]): readonly JavaTypeDeclaration[] => {
  const byFile = new Map<string, JavaTypeDeclaration[]>();
  for (const declaration of declarations) {
    const existing = byFile.get(declaration.file);
    if (existing) existing.push(declaration);
    else byFile.set(declaration.file, [declaration]);
  }
  const qualified: JavaTypeDeclaration[] = [];
  for (const fileDeclarations of byFile.values()) {
    const ordered = [...fileDeclarations].sort((left, right) => left.startIndex - right.startIndex);
    const updated: JavaTypeDeclaration[] = [];
    for (const declaration of ordered) {
      const parent = updated
        .filter((candidate) => candidate.startIndex < declaration.startIndex && candidate.endIndex >= declaration.endIndex)
        .sort((left, right) => right.startIndex - left.startIndex)[0];
      updated.push(parent ? { ...declaration, qualifiedName: `${parent.qualifiedName}.${declaration.name}` } : declaration);
    }
    qualified.push(...updated);
  }
  return qualified;
};

const typeDeclarations = async (
  parser: ParserService,
  files: readonly string[],
): Promise<readonly JavaTypeDeclaration[]> => {
  const declarations: JavaTypeDeclaration[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const packageName = packageNameOf(source);
    const matches = await Effect.runPromise(parser.query(file, DECLARATION_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))));
    for (const match of matches) {
      const name = captureOf(match, "name");
      const declaration = declarationNodeOf(match);
      const kind = declarationKindOf(match);
      if (!name || !declaration || !kind) continue;
      if (name.startLine === undefined || name.startIndex === undefined) continue;
      if (declaration.startLine === undefined || declaration.endLine === undefined
        || declaration.startIndex === undefined || declaration.endIndex === undefined) continue;
      declarations.push({
        file,
        name: name.text,
        kind,
        startLine: declaration.startLine,
        endLine: declaration.endLine,
        startIndex: declaration.startIndex,
        endIndex: declaration.endIndex,
        nameStartLine: name.startLine,
        nameStartIndex: name.startIndex,
        qualifiedName: packageName ? `${packageName}.${name.text}` : name.text,
      });
    }
  }
  return withQualifiedNames(declarations);
};

const enclosingDeclaration = (
  declarations: readonly JavaTypeDeclaration[],
  file: string,
  line: number,
): JavaTypeDeclaration | undefined =>
  declarations
    .filter((declaration) => declaration.file === file && line >= declaration.startLine && line <= declaration.endLine)
    .sort((left, right) => right.startIndex - left.startIndex)[0];

const declarationAtName = (
  declarations: readonly JavaTypeDeclaration[],
  file: string,
  nameLine: number,
): JavaTypeDeclaration | undefined =>
  declarations.find((declaration) => declaration.file === file && declaration.nameStartLine === nameLine);

const sourceSymbol = (declaration: JavaTypeDeclaration, file: string): SemanticRelationSymbol => ({
  id: `java:repository:${file}:${declaration.qualifiedName}`,
  name: declaration.name,
  kind: declaration.kind,
  scope: "repository",
  file,
  line: declaration.nameStartLine,
});

const resolveTarget = (
  cwd: string,
  declarations: readonly JavaTypeDeclaration[],
  uri: string,
  line: number,
): JavaTarget | undefined => {
  const file = relationRepositoryPath(cwd, uri);
  if (!file) return undefined;
  const absolute = resolve(cwd, file);
  const exact = declarations.find((declaration) => declaration.file === absolute && declaration.nameStartLine === line);
  const byRange = exact ?? declarations
    .filter((declaration) => declaration.file === absolute && line >= declaration.startLine && line <= declaration.endLine)
    .sort((left, right) => right.startIndex - left.startIndex)[0];
  return byRange ? { declaration: byRange, file } : undefined;
};

const javaWorkspaceRisks = (_context: { readonly cwd: string; readonly files: readonly string[] }): readonly string[] => [];

const collectJavaCandidates = async (
  parser: ParserService,
  files: readonly string[],
  declarations: readonly JavaTypeDeclaration[],
  sources: ReadonlyMap<string, string>,
): Promise<readonly RelationCandidate[]> => {
  const declaredNames = new Set(declarations.map((declaration) => declaration.name));
  const candidates: RelationCandidate[] = [];
  const pushMatches = (
    file: string,
    source: string,
    matches: readonly QueryMatch[],
    kind: SemanticRelationFact["kind"],
    sourceOf: (match: QueryMatch) => JavaTypeDeclaration | undefined,
  ): void => {
    for (const match of matches) {
      const typeRef = captureOf(match, "typeRef");
      if (!typeRef || typeRef.startLine === undefined || typeRef.startIndex === undefined || typeRef.endIndex === undefined) continue;
      if (isNonRepositoryType(typeRef.text)) continue;
      if (!declaredNames.has(simpleTypeName(typeRef.text))) continue;
      const sourceOfMatch = sourceOf(match);
      if (!sourceOfMatch) continue;
      candidates.push({
        kind,
        file,
        line: typeRef.startLine,
        typeRef: typeRef.text,
        startIndex: lastIdentifierOffset(source, typeRef.startIndex, typeRef.endIndex),
        endIndex: typeRef.endIndex,
        source: sourceOfMatch,
      });
    }
  };

  for (const file of files) {
    const fileDeclarations = declarations.filter((declaration) => declaration.file === file);
    const sourceForName = (match: QueryMatch): JavaTypeDeclaration | undefined => {
      const className = captureOf(match, "className");
      if (!className || className.startLine === undefined) return undefined;
      return declarationAtName(fileDeclarations, file, className.startLine);
    };
    const enclosing = (line: number): JavaTypeDeclaration | undefined => enclosingDeclaration(fileDeclarations, file, line);
    const [extendsMatches, implementsMatches, fieldMatches, parameterMatches, returnMatches, instantiateMatches] = await Effect.runPromise(Effect.all([
      parser.query(file, EXTENDS_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
      parser.query(file, IMPLEMENTS_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
      parser.query(file, FIELD_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
      parser.query(file, PARAMETER_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
      parser.query(file, RETURN_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
      parser.query(file, INSTANTIATE_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
    ]));
    pushMatches(file, sources.get(file)!, extendsMatches, "extends", sourceForName);
    pushMatches(file, sources.get(file)!, implementsMatches, "implements", sourceForName);
    pushMatches(file, sources.get(file)!, fieldMatches, "field_type", (match) => enclosing(captureOf(match, "typeRef")?.startLine ?? -1));
    pushMatches(file, sources.get(file)!, parameterMatches, "parameter_type", (match) => enclosing(captureOf(match, "typeRef")?.startLine ?? -1));
    pushMatches(file, sources.get(file)!, returnMatches, "return_type", (match) => enclosing(captureOf(match, "typeRef")?.startLine ?? -1));
    pushMatches(file, sources.get(file)!, instantiateMatches, "instantiates", (match) => enclosing(captureOf(match, "typeRef")?.startLine ?? -1));
  }
  return candidates;
};

const resolveJavaTargets = async (
  session: LspSession,
  candidate: RelationCandidate,
  ctx: { readonly cwd: string; readonly sources: ReadonlyMap<string, string>; readonly declarations: readonly JavaTypeDeclaration[] },
): Promise<readonly JavaTarget[]> => {
  const response = await session.request("textDocument/definition", {
    textDocument: { uri: pathToFileURL(candidate.file).href },
    position: relationPositionForOffset(ctx.sources.get(candidate.file)!, candidate.startIndex),
  }, LSP_REQUEST_TIMEOUT_MS);
  return relationDefinitionLocations(response).flatMap(({ file: uri, line }) => {
    const target = resolveTarget(ctx.cwd, ctx.declarations, uri, line);
    return target ? [target] : [];
  });
};

const javaKernel: LspResolutionKernel<JavaTypeDeclaration, RelationCandidate, JavaTarget> = {
  id: "java-jdtls-semantic-relations",
  displayName: "jdtls",
  language: "java",
  providerId: "java-jdtls-semantic-relations",
  languageId: "java",
  diagnosticsMode: "whenNoCandidates",
  launch: (executable) => relationLaunch(executable),
  collectDeclarations: typeDeclarations,
  collectCandidates: collectJavaCandidates,
  resolveCandidate: resolveJavaTargets,
  sourceFileOf: (candidate) => candidate.file,
  sourceDeclarationOf: (candidate) => candidate.source,
  offsetOf: (candidate) => candidate.startIndex,
  lineOf: (candidate) => candidate.line,
  targetFileOf: (target) => target.file,
  sourceSymbol: (source, file) => sourceSymbol(source, file),
  targetSymbol: (target, file) => sourceSymbol(target.declaration, file),
  factOf: (candidate, source, target, file, line): SemanticRelationFact => ({
    language: "java",
    kind: candidate.kind,
    source,
    target,
    direct: true,
    evidence: { file, line },
  }),
  workspaceRisks: (cwd, files) => javaWorkspaceRisks({ cwd, files }),
  isComplete: (stats, diagnosticsReady, risks, warmupIncomplete, candidates, _readinessReady) => {
    const requestComplete = candidates.length === 0
      ? diagnosticsReady
      : stats.unresolved === 0 && stats.resolved === candidates.length && stats.targetCount > 0;
    return requestComplete && !warmupIncomplete && risks.length === 0;
  },
  partialReasons: (stats, diagnosticsReady, risks, warmupIncomplete, candidates, _readinessReady) => [
    ...(candidates.length === 0 && !diagnosticsReady ? ["jdtls diagnostics readiness did not complete"] : []),
    ...(warmupIncomplete ? ["some documentSymbol warmup requests failed"] : []),
    ...(risks.length > 0 ? risks : []),
    ...(stats.unresolved > 0 ? [`${stats.unresolved} definition requests failed`] : []),
    ...(candidates.length > 0 && stats.resolved > 0 && stats.targetCount === 0 ? ["no candidate definition resolved to a repository target"] : []),
  ],
};

export const collectJavaSemanticRelations = (
  input: SemanticRelationRequest,
  runtime: JavaSemanticRelationRuntime,
): Effect.Effect<SemanticRelationReport, never> =>
  Effect.gen(function* () {
    const parser = runtime.parser;
    if (!parser) return {
      origin: { language: "java", providerId: "java-jdtls-semantic-relations", evidenceSource: "lsp" },
      state: { availability: "unavailable", coverage: { symbols: "unavailable", relations: "unavailable" }, reason: "ParserService is unavailable" },
      facts: [],
    } satisfies SemanticRelationReport;
    return yield* Effect.promise(() => runLspResolutionPipeline({
      cwd: input.cwd,
      parser,
      runtime,
      kernel: javaKernel,
    }));
  });

export const javaSemanticRelationProvider: SemanticRelationProvider = {
  id: "java-jdtls-semantic-relations",
  evidenceSource: "lsp",
  languages: ["java"],
  requiredToolchains: ["jdtls"],
  collect: (input, context) => collectJavaSemanticRelations(input, {
    parser: context.parser,
    executable: context.toolchains.get("jdtls")?.executable,
  }),
};
