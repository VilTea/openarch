import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import type { ParserService, QueryMatch } from "../../port/ParserService";
import type { LspLaunchSpec, LspSession } from "../lsp/NodeLspSession";
import { relationDefinitionLocations, relationPositionForOffset, relationRepositoryPath } from "./relationLsp";
import { runLspResolutionPipeline, type LspResolutionKernel, type PipelineRuntime } from "./semanticRelationPipeline";
import { captureOf, LSP_REQUEST_TIMEOUT_MS } from "./semanticRelationShared";
import type { SemanticRelationProvider, SemanticRelationRequest } from "../../semantic-relations/provider";
import type { SemanticRelationFact, SemanticRelationReport, SemanticRelationSymbol } from "../../semantic-relations/types";

interface GoTypeDeclaration {
  readonly file: string;
  readonly name: string;
  readonly kind: "struct" | "interface";
  readonly startLine: number;
  readonly endLine: number;
  readonly startIndex: number;
  readonly packageDir: string;
}

interface GoMethodDeclaration {
  readonly file: string;
  readonly receiverType: string;
  readonly startLine: number;
  readonly endLine: number;
}

interface RelationCandidate {
  readonly kind: SemanticRelationFact["kind"];
  readonly file: string;
  readonly line: number;
  readonly typeRef: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly source: GoTypeDeclaration;
}

interface GoTarget {
  readonly declaration: GoTypeDeclaration;
  readonly file: string;
}

export interface GoSemanticRelationRuntime extends PipelineRuntime {
  readonly parser?: ParserService;
}

// Go deliberately emits no "implements" relations. Interface satisfaction is
// structural in Go and cannot be proven with a single textDocument/definition
// request.
const STRUCT_DECLARATION_QUERY = "(type_spec name: (type_identifier) @name type: (struct_type) @body)";
const INTERFACE_DECLARATION_QUERY = "(type_spec name: (type_identifier) @name type: (interface_type) @body)";
const METHOD_RANGE_QUERY = "[(method_declaration receiver: (parameter_list (parameter_declaration type: (type_identifier) @receiverType))) @method (method_declaration receiver: (parameter_list (parameter_declaration type: (pointer_type (type_identifier) @receiverType)))) @method]";
const STRUCT_FIELD_QUERY = "(type_spec name: (type_identifier) @sourceName type: (struct_type (field_declaration_list (field_declaration name: (field_identifier)? @fieldName type: (type_identifier) @typeRef))))";
const STRUCT_POINTER_FIELD_QUERY = "(type_spec name: (type_identifier) @sourceName type: (struct_type (field_declaration_list (field_declaration name: (field_identifier)? @fieldName type: (pointer_type (type_identifier) @typeRef)))))";
const INTERFACE_EMBED_QUERY = "(type_spec name: (type_identifier) @sourceName type: (interface_type (type_elem (type_identifier) @typeRef)))";
const METHOD_PARAMETER_QUERY = "[(method_declaration parameters: (parameter_list (parameter_declaration type: (type_identifier) @typeRef))) (method_declaration parameters: (parameter_list (parameter_declaration type: (pointer_type (type_identifier) @typeRef))))]";
const METHOD_RESULT_QUERY = "[(method_declaration result: (type_identifier) @typeRef) (method_declaration result: (pointer_type (type_identifier) @typeRef)) (method_declaration result: (parameter_list (parameter_declaration type: (type_identifier) @typeRef))) (method_declaration result: (parameter_list (parameter_declaration type: (pointer_type (type_identifier) @typeRef))))]";
const INSTANTIATE_QUERY = "(composite_literal type: (type_identifier) @typeRef)";

const debugLog = (message: string): void => {
  if (process.env.OPENARCH_GO_SEMANTIC_DEBUG === "1") console.error(`[go-semantic-relations] ${message}`);
};

const declarationKey = (file: string, name: string): string => `${file}\0${name}`;
const packageDeclarationKey = (packageDir: string, name: string): string => `${packageDir}\0${name}`;

const queryGo = (parser: ParserService, file: string, pattern: string): Promise<readonly QueryMatch[]> =>
  Effect.runPromise(parser.query(file, pattern).pipe(Effect.catchAll(() => Effect.succeed([]))));

const collectTypeDeclarations = async (
  parser: ParserService,
  files: readonly string[],
): Promise<readonly GoTypeDeclaration[]> => {
  const declarations: GoTypeDeclaration[] = [];
  for (const file of files) {
    const [structs, interfaces] = await Promise.all([
      queryGo(parser, file, STRUCT_DECLARATION_QUERY),
      queryGo(parser, file, INTERFACE_DECLARATION_QUERY),
    ]);
    for (const [kind, matches] of [["struct", structs], ["interface", interfaces]] as const) {
      for (const match of matches) {
        const name = captureOf(match, "name");
        const body = captureOf(match, "body");
        if (!name || name.startLine === undefined || name.startIndex === undefined) continue;
        declarations.push({
          file,
          name: name.text,
          kind,
          startLine: name.startLine,
          endLine: body?.endLine ?? name.endLine ?? name.startLine,
          startIndex: name.startIndex,
          packageDir: dirname(file),
        });
      }
    }
  }
  return declarations;
};

const collectMethodDeclarations = async (
  parser: ParserService,
  files: readonly string[],
): Promise<readonly GoMethodDeclaration[]> => {
  const methods: GoMethodDeclaration[] = [];
  for (const file of files) {
    const matches = await queryGo(parser, file, METHOD_RANGE_QUERY);
    for (const match of matches) {
      const method = captureOf(match, "method");
      const receiver = captureOf(match, "receiverType");
      if (!method || method.startLine === undefined || method.endLine === undefined) continue;
      if (!receiver) continue;
      methods.push({ file, receiverType: receiver.text, startLine: method.startLine, endLine: method.endLine });
    }
  }
  return methods;
};

const collectGoCandidates = async (
  parser: ParserService,
  files: readonly string[],
  declarations: readonly GoTypeDeclaration[],
  methods: readonly GoMethodDeclaration[],
): Promise<readonly RelationCandidate[]> => {
  const declarationsByFileAndName = new Map(declarations.map((declaration) => [declarationKey(declaration.file, declaration.name), declaration]));
  const declarationsByPackageAndName = new Map(declarations.map((declaration) => [packageDeclarationKey(declaration.packageDir, declaration.name), declaration]));
  const methodsByFile = new Map<string, GoMethodDeclaration[]>();
  for (const method of methods) {
    const existing = methodsByFile.get(method.file) ?? [];
    existing.push(method);
    methodsByFile.set(method.file, existing);
  }
  const methodFor = (file: string, line: number): GoMethodDeclaration | undefined =>
    methodsByFile.get(file)?.find((method) => line >= method.startLine && line <= method.endLine);
  const sourceDeclarationForMethod = (method: GoMethodDeclaration): GoTypeDeclaration | undefined =>
    declarationsByPackageAndName.get(packageDeclarationKey(dirname(method.file), method.receiverType));
  const candidates: RelationCandidate[] = [];

  const pushMatches = (
    file: string,
    matches: readonly QueryMatch[],
    kind: SemanticRelationFact["kind"],
    sourceOf: (match: QueryMatch) => GoTypeDeclaration | undefined,
  ): void => {
    for (const match of matches) {
      const typeRef = captureOf(match, "typeRef");
      if (!typeRef || typeRef.startIndex === undefined || typeRef.endIndex === undefined || typeRef.startLine === undefined) continue;
      const source = sourceOf(match);
      if (!source) continue;
      candidates.push({ kind, file, line: typeRef.startLine, typeRef: typeRef.text, startIndex: typeRef.startIndex, endIndex: typeRef.endIndex, source });
    }
  };

  const pushMethodScoped = (file: string, matches: readonly QueryMatch[], kind: SemanticRelationFact["kind"]): void => {
    for (const match of matches) {
      const typeRef = captureOf(match, "typeRef");
      if (!typeRef || typeRef.startIndex === undefined || typeRef.endIndex === undefined || typeRef.startLine === undefined) continue;
      const method = methodFor(file, typeRef.startLine);
      const source = method ? sourceDeclarationForMethod(method) : undefined;
      if (!source) continue;
      candidates.push({ kind, file, line: typeRef.startLine, typeRef: typeRef.text, startIndex: typeRef.startIndex, endIndex: typeRef.endIndex, source });
    }
  };

  for (const file of files) {
    const [fields, pointerFields, interfaceEmbeds, parameters, results, instantiates] = await Promise.all([
      queryGo(parser, file, STRUCT_FIELD_QUERY),
      queryGo(parser, file, STRUCT_POINTER_FIELD_QUERY),
      queryGo(parser, file, INTERFACE_EMBED_QUERY),
      queryGo(parser, file, METHOD_PARAMETER_QUERY),
      queryGo(parser, file, METHOD_RESULT_QUERY),
      queryGo(parser, file, INSTANTIATE_QUERY),
    ]);
    const declarationInFile = (name: string | undefined): GoTypeDeclaration | undefined =>
      name ? declarationsByFileAndName.get(declarationKey(file, name)) : undefined;

    pushMatches(file, fields, "embeds", (match) =>
      captureOf(match, "fieldName") ? undefined : declarationInFile(captureOf(match, "sourceName")?.text));
    pushMatches(file, fields, "field_type", (match) =>
      captureOf(match, "fieldName") ? declarationInFile(captureOf(match, "sourceName")?.text) : undefined);
    pushMatches(file, pointerFields, "embeds", (match) =>
      captureOf(match, "fieldName") ? undefined : declarationInFile(captureOf(match, "sourceName")?.text));
    pushMatches(file, pointerFields, "field_type", (match) =>
      captureOf(match, "fieldName") ? declarationInFile(captureOf(match, "sourceName")?.text) : undefined);
    pushMatches(file, interfaceEmbeds, "embeds", (match) => declarationInFile(captureOf(match, "sourceName")?.text));
    pushMethodScoped(file, parameters, "parameter_type");
    pushMethodScoped(file, results, "return_type");
    pushMethodScoped(file, instantiates, "instantiates");
  }
  return candidates;
};

const goWorkspaceRisks = (cwd: string): readonly string[] => {
  const risks: string[] = [];
  if (!existsSync(join(cwd, "go.mod"))) {
    risks.push("Go semantic relations require a module rooted at the governed project");
  }
  if (existsSync(join(cwd, "go.work"))) {
    risks.push("Go workspace mode is outside the calibrated single-module semantic-relations scope");
  }
  return risks;
};

const symbolFor = (declaration: GoTypeDeclaration, file: string): SemanticRelationSymbol => ({
  id: `go:repository:${file}:${declaration.name}`,
  name: declaration.name,
  kind: declaration.kind,
  scope: "repository",
  file,
  line: declaration.startLine,
});

const resolveTargetDeclaration = (
  cwd: string,
  declarations: readonly GoTypeDeclaration[],
  uri: string,
  line: number,
): GoTarget | undefined => {
  const file = relationRepositoryPath(cwd, uri);
  if (!file) return undefined;
  const absolute = resolve(cwd, file);
  const byRange = declarations.find((declaration) => declaration.file === absolute && line >= declaration.startLine && line <= declaration.endLine);
  return byRange ? { declaration: byRange, file } : undefined;
};

const resolveGoTargets = async (
  session: LspSession,
  candidate: RelationCandidate,
  ctx: { readonly cwd: string; readonly sources: ReadonlyMap<string, string>; readonly declarations: readonly GoTypeDeclaration[] },
): Promise<readonly GoTarget[]> => {
  const response = await session.request("textDocument/definition", {
    textDocument: { uri: pathToFileURL(candidate.file).href },
    position: relationPositionForOffset(ctx.sources.get(candidate.file)!, candidate.startIndex),
  }, LSP_REQUEST_TIMEOUT_MS);
  return relationDefinitionLocations(response).flatMap(({ file: uri, line }) => {
    const target = resolveTargetDeclaration(ctx.cwd, ctx.declarations, uri, line);
    return target ? [target] : [];
  });
};

const goKernel: LspResolutionKernel<GoTypeDeclaration, RelationCandidate, GoTarget> = {
  id: "go-gopls-semantic-relations",
  displayName: "gopls",
  language: "go",
  providerId: "go-gopls-semantic-relations",
  languageId: "go",
  diagnosticsMode: "always",
  concurrency: 12,
  shouldWarmup: () => process.env.OPENARCH_GOPLS_DAEMON === "off",
  launch: (executable, runtime) => ({
    command: executable,
    args: (process.env.OPENARCH_GOPLS_DAEMON === "off" ? ["serve"] : ["-remote=auto"]) as readonly string[],
    shutdown: (process.env.OPENARCH_GOPLS_DAEMON === "off" ? "tree" : "self") as "tree" | "self",
    ...(runtime.environment ? { environment: runtime.environment } : {}),
  }),
  collectDeclarations: collectTypeDeclarations,
  collectCandidates: async (parser, files, declarations) => {
    const methods = await collectMethodDeclarations(parser, files);
    return collectGoCandidates(parser, files, declarations, methods);
  },
  resolveCandidate: resolveGoTargets,
  sourceFileOf: (candidate) => candidate.file,
  sourceDeclarationOf: (candidate) => candidate.source,
  offsetOf: (candidate) => candidate.startIndex,
  lineOf: (candidate) => candidate.line,
  targetFileOf: (target) => target.file,
  sourceSymbol: (source, file) => symbolFor(source, file),
  targetSymbol: (target, file) => symbolFor(target.declaration, file),
  factOf: (candidate, source, target, file, line): SemanticRelationFact => ({
    language: "go",
    kind: candidate.kind,
    source,
    target,
    direct: true,
    evidence: { file, line },
  }),
  workspaceRisks: (cwd) => goWorkspaceRisks(cwd),
  isComplete: (stats, diagnosticsReady, risks, warmupIncomplete, candidates, _readinessReady) =>
    stats.unresolved === 0 && stats.resolved === candidates.length && stats.targetCount > 0
    && diagnosticsReady && !warmupIncomplete && risks.length === 0,
  partialReasons: (stats, diagnosticsReady, risks, warmupIncomplete, candidates, _readinessReady) => [
    ...(!diagnosticsReady ? ["gopls diagnostics readiness did not complete"] : []),
    ...(warmupIncomplete ? ["some documentSymbol warmup requests failed"] : []),
    ...risks,
    ...(stats.unresolved > 0 ? [`${stats.unresolved} definition requests failed`] : []),
    ...(candidates.length > 0 && stats.resolved > 0 && stats.targetCount === 0 ? ["no candidate definition resolved to a repository target"] : []),
  ],
};

export const collectGoSemanticRelations = (
  input: SemanticRelationRequest,
  runtime: GoSemanticRelationRuntime,
): Effect.Effect<SemanticRelationReport, never> =>
  Effect.gen(function* () {
    const parser = runtime.parser;
    if (!parser) return {
      origin: { language: "go", providerId: "go-gopls-semantic-relations", evidenceSource: "lsp" },
      state: { availability: "unavailable", coverage: { symbols: "unavailable", relations: "unavailable" }, reason: "ParserService is unavailable" },
      facts: [],
    } satisfies SemanticRelationReport;
    return yield* Effect.promise(() => runLspResolutionPipeline({
      cwd: input.cwd,
      parser,
      runtime,
      kernel: goKernel,
    }));
  });

export const goSemanticRelationProvider: SemanticRelationProvider = {
  id: "go-gopls-semantic-relations",
  evidenceSource: "lsp",
  languages: ["go"],
  requiredToolchains: ["gopls"],
  collect: (input, context) => collectGoSemanticRelations(input, {
    parser: context.parser,
    executable: context.toolchains.get("gopls")?.executable,
  }),
};
