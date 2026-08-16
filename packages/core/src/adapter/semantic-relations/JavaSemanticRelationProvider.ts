import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import type { ParserService, QueryCapture, QueryMatch } from "../../port/ParserService";
import type { LspLaunchSpec, LspSession } from "../lsp/NodeLspSession";
import { listProjectSourceFiles } from "../../projectFiles";
import type { SemanticRelationProvider, SemanticRelationRequest } from "../../semantic-relations/provider";
import type { SemanticRelationFact, SemanticRelationReport, SemanticRelationSymbol } from "../../semantic-relations/types";
import {
  defaultRelationStartSession,
  initializeRelationWorkspace,
  openRelationDocuments,
  relationDefinitionLocations,
  relationLaunch,
  relationPositionForOffset,
  relationRelativeFile,
  relationRepositoryPath,
  warmupRelationDocuments,
} from "./relationLsp";

const DIAGNOSTIC_READINESS_TIMEOUT_MS = Number(process.env.OPENARCH_LSP_INDEX_TIMEOUT_MS ?? 180_000);
const LSP_REQUEST_TIMEOUT_MS = Number(process.env.OPENARCH_LSP_REQUEST_TIMEOUT_MS ?? 120_000);

/** Java primitive and void type references can never resolve to repository symbols. */
const NON_REPOSITORY_TYPES = new Set(["byte", "short", "int", "long", "char", "float", "double", "boolean", "void"]);

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
  readonly source?: JavaTypeDeclaration;
}

export interface JavaSemanticRelationRuntime {
  readonly parser?: ParserService;
  readonly executable?: string;
  readonly startSession?: (launch: LspLaunchSpec, cwd: string) => LspSession | Promise<LspSession>;
}

/**
 * tree-sitter-java anchors. The declaration pattern captures the whole
 * declaration node under a kind-specific name so class/record (both kind
 * "class"), interface and enum declarations can share one pass.
 */
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

/** Method and constructor signatures only; lambda and record-component parameters are not signature parameters. */
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

const captureOf = (match: QueryMatch, name: string): QueryCapture | undefined =>
  match.captures.find((capture) => capture.name === name);

const packageNameOf = (source: string): string | undefined =>
  /package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/.exec(source)?.[1];

/** Last Java identifier segment of a type reference, ignoring arrays and type arguments. */
const simpleTypeName = (typeRef: string): string => {
  const withoutBrackets = typeRef.replace(/\[\s*\]/g, "").trim();
  const withoutGenerics = withoutBrackets.replace(/<[\s\S]*>$/, "").trim();
  const segments = withoutGenerics.split(".");
  return (segments[segments.length - 1] ?? withoutGenerics).trim();
};

const isNonRepositoryType = (typeRef: string): boolean => NON_REPOSITORY_TYPES.has(simpleTypeName(typeRef));

/**
 * Scoped type references (e.g. com.api.Result, java.util.List<String>) must
 * resolve from the final identifier segment, not the leading package segment.
 * Mirrors the Python provider's lastIdentifierOffset for Java identifier chars.
 */
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

/** Nested classes are owned by their innermost containing declaration; ids use the qualified name. */
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

const uniqueFacts = (facts: readonly SemanticRelationFact[]): readonly SemanticRelationFact[] => {
  const byIdentity = new Map<string, SemanticRelationFact>();
  for (const fact of facts) {
    const key = `${fact.source.id}\0${fact.kind}\0${fact.target.id}\0${fact.evidence.file}\0${fact.evidence.line}`;
    byIdentity.set(key, fact);
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.evidence.file.localeCompare(right.evidence.file)
    || left.evidence.line - right.evidence.line
    || left.kind.localeCompare(right.kind)
    || left.source.id.localeCompare(right.source.id)
    || left.target.id.localeCompare(right.target.id));
};

const resolveTarget = (
  cwd: string,
  declarations: readonly JavaTypeDeclaration[],
  uri: string,
  line: number,
): { readonly declaration: JavaTypeDeclaration; readonly file: string } | undefined => {
  const file = relationRepositoryPath(cwd, uri);
  if (!file) return undefined;
  const absolute = resolve(cwd, file);
  const exact = declarations.find((declaration) => declaration.file === absolute && declaration.nameStartLine === line);
  const byRange = exact ?? declarations
    .filter((declaration) => declaration.file === absolute && line >= declaration.startLine && line <= declaration.endLine)
    .sort((left, right) => right.startIndex - left.startIndex)[0];
  return byRange ? { declaration: byRange, file } : undefined;
};

/**
 * JDT LS resolves against whatever its workspace sees, but targets outside the
 * governed repository are skipped and all anchors come from governed sources.
 * Unlike Pyright, JDT LS has no scope-widening configuration file that changes
 * which repository source wins a definition, so there is no workspace risk to
 * report for the calibrated direct-static scope.
 */
const javaWorkspaceRisks = (_context: { readonly cwd: string; readonly files: readonly string[] }): readonly string[] => [];

const unavailable = (reason: string): SemanticRelationReport => ({
  origin: { language: "java", providerId: "java-jdtls-semantic-relations", evidenceSource: "lsp" },
  state: { availability: "unavailable", coverage: { symbols: "unavailable", relations: "unavailable" }, reason },
  facts: [],
});

export const collectJavaSemanticRelations = (
  input: SemanticRelationRequest,
  runtime: JavaSemanticRelationRuntime,
): Effect.Effect<SemanticRelationReport, never> =>
  Effect.gen(function* () {
    const parser = runtime.parser;
    const executable = runtime.executable;
    if (!parser) return unavailable("ParserService is unavailable");
    if (!executable) return unavailable("jdtls executable is unavailable; configure the java toolchain");
    const files = listProjectSourceFiles({ cwd: input.cwd, languages: ["java"], population: "production-governance" });
    if (files.length === 0) return unavailable("no governed Java source files");

    const declarations = yield* Effect.promise(() => typeDeclarations(parser, files));
    const declaredNames = new Set(declarations.map((declaration) => declaration.name));
    const sources = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));

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
        // Only a type reference whose simple name is declared in the repository
        // can resolve to a repository target; primitives/void never can.
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
      const [extendsMatches, implementsMatches, fieldMatches, parameterMatches, returnMatches, instantiateMatches] = yield* Effect.all([
        parser.query(file, EXTENDS_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
        parser.query(file, IMPLEMENTS_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
        parser.query(file, FIELD_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
        parser.query(file, PARAMETER_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
        parser.query(file, RETURN_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
        parser.query(file, INSTANTIATE_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
      ]);
      pushMatches(file, sources.get(file)!, extendsMatches, "extends", sourceForName);
      pushMatches(file, sources.get(file)!, implementsMatches, "implements", sourceForName);
      pushMatches(file, sources.get(file)!, fieldMatches, "field_type", (match) => enclosing(captureOf(match, "typeRef")?.startLine ?? -1));
      pushMatches(file, sources.get(file)!, parameterMatches, "parameter_type", (match) => enclosing(captureOf(match, "typeRef")?.startLine ?? -1));
      pushMatches(file, sources.get(file)!, returnMatches, "return_type", (match) => enclosing(captureOf(match, "typeRef")?.startLine ?? -1));
      pushMatches(file, sources.get(file)!, instantiateMatches, "instantiates", (match) => enclosing(captureOf(match, "typeRef")?.startLine ?? -1));
    }

    return yield* Effect.promise(async (): Promise<SemanticRelationReport> => {
      const launch = relationLaunch(executable);
      let session: LspSession;
      try {
        session = await (runtime.startSession ?? defaultRelationStartSession)(launch, input.cwd);
      } catch (error) {
        return unavailable(`failed to start jdtls: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        try {
          await initializeRelationWorkspace(session, input.cwd, "definitionProvider");
        } catch (error) {
          return unavailable(`failed to initialize jdtls: ${error instanceof Error ? error.message : String(error)}`);
        }

        const sources = openRelationDocuments(session, files, "java");
        const warmupIncomplete = await warmupRelationDocuments(session, files, LSP_REQUEST_TIMEOUT_MS);
        // JDT LS diagnostics are only the readiness gate for an empty candidate
        // set; with candidates, successful definition requests already prove the
        // index is usable and JDT is single-threaded, so do not pay a second wait.
        let diagnosticsReady = true;
        if (candidates.length === 0 && session.waitForDiagnostics) {
          diagnosticsReady = await session.waitForDiagnostics(
            files.map((file) => pathToFileURL(file).href),
            DIAGNOSTIC_READINESS_TIMEOUT_MS,
          ).catch(() => false);
        }

        const risks = javaWorkspaceRisks({ cwd: input.cwd, files });
        let resolved = 0;
        let unresolved = 0;
        let targetCount = 0;
        const facts: SemanticRelationFact[] = [];
        for (const candidate of candidates) {
          if (!candidate.source) continue;
          const position = relationPositionForOffset(sources.get(candidate.file)!, candidate.startIndex);
          let targets: readonly { readonly declaration: JavaTypeDeclaration; readonly file: string }[] = [];
          try {
            const response = await session.request("textDocument/definition", {
              textDocument: { uri: pathToFileURL(candidate.file).href },
              position,
            }, LSP_REQUEST_TIMEOUT_MS);
            resolved += 1;
            targets = relationDefinitionLocations(response).flatMap(({ file: uri, line }) => {
              const target = resolveTarget(input.cwd, declarations, uri, line);
              return target ? [target] : [];
            });
            targetCount += targets.length;
          } catch {
            unresolved += 1;
          }
          const sourceFile = relationRelativeFile(input.cwd, candidate.file);
          const source = sourceSymbol(candidate.source, sourceFile);
          for (const target of targets) {
            facts.push({
              language: "java",
              kind: candidate.kind,
              source,
              target: sourceSymbol(target.declaration, target.file),
              direct: true,
              evidence: { file: sourceFile, line: candidate.line },
            });
          }
        }

        const requestComplete = candidates.length === 0
          ? diagnosticsReady
          : unresolved === 0 && resolved === candidates.length && targetCount > 0;
        const complete = requestComplete && !warmupIncomplete && risks.length === 0;
        return {
          origin: { language: "java", providerId: "java-jdtls-semantic-relations", evidenceSource: "lsp" },
          state: {
            availability: complete ? "available" : "partial",
            coverage: {
              symbols: complete ? "complete" : "partial",
              relations: complete ? "complete" : "partial",
            },
            ...(complete ? {} : { reason: [
              ...(candidates.length === 0 && !diagnosticsReady ? ["jdtls diagnostics readiness did not complete"] : []),
              ...(warmupIncomplete ? ["some documentSymbol warmup requests failed"] : []),
              ...(risks.length > 0 ? risks : []),
              ...(unresolved > 0 ? [`${unresolved} definition requests failed`] : []),
              ...(candidates.length > 0 && resolved > 0 && targetCount === 0 ? ["no candidate definition resolved to a repository target"] : []),
            ].join("; ") }),
          },
          facts: uniqueFacts(facts),
        };
      } finally {
        await Promise.resolve(session.close());
      }
    });
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
