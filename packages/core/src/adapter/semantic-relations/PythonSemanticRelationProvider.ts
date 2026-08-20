import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import type { ParserService, QueryMatch } from "../../port/ParserService";
import type { LspLaunchSpec, LspSession } from "../lsp/NodeLspSession";
import { relationDefinitionLocations, relationLaunchForNodeEntry, relationPositionForOffset, relationRepositoryPath } from "./relationLsp";
import { runLspResolutionPipeline, type LspResolutionKernel, type PipelineRuntime } from "./semanticRelationPipeline";
import { captureOf, LSP_REQUEST_TIMEOUT_MS } from "./semanticRelationShared";
import { pyrightWorkspaceRisks } from "../symbol-use/PyrightWorkspaceScope";
import type { SemanticRelationProvider, SemanticRelationRequest } from "../../semantic-relations/provider";
import type { SemanticRelationFact, SemanticRelationReport, SemanticRelationSymbol } from "../../semantic-relations/types";

interface ClassDeclaration {
  readonly file: string;
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startIndex: number;
}

interface RelationCandidate {
  readonly kind: SemanticRelationFact["kind"];
  readonly file: string;
  readonly line: number;
  readonly typeRef: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly source?: ClassDeclaration;
}

interface PythonTarget {
  readonly declaration: ClassDeclaration;
  readonly file: string;
}

export interface PythonSemanticRelationRuntime extends PipelineRuntime {
  readonly parser?: ParserService;
}

const CLASS_QUERY = "(class_definition name: (identifier) @name body: (block) @body)";
const BASE_QUERY = `[
  (class_definition name: (identifier) @className superclasses: (argument_list (identifier) @typeRef))
  (class_definition name: (identifier) @className superclasses: (argument_list (attribute attribute: (identifier) @typeRef)))
]`;
const PARAMETER_QUERY = "(function_definition parameters: (parameters (typed_parameter type: (type) @typeRef)))";
const RETURN_QUERY = "(function_definition return_type: (type) @typeRef)";
const FIELD_QUERY = "(expression_statement (assignment left: (identifier) @fieldName type: (type) @typeRef))";
const INSTANTIATE_QUERY = `[
  (call function: (identifier) @typeRef)
  (call function: (attribute attribute: (identifier) @typeRef))
]`;

const lastIdentifierOffset = (source: string, startIndex: number, endIndex: number): number => {
  const slice = source.slice(startIndex, endIndex);
  const match = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(slice);
  return match ? startIndex + match.index : startIndex;
};

const classDeclarations = async (
  parser: ParserService,
  files: readonly string[],
): Promise<readonly ClassDeclaration[]> => {
  const declarations: ClassDeclaration[] = [];
  for (const file of files) {
    const matches = await Effect.runPromise(parser.query(file, CLASS_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))));
    for (const match of matches) {
      const name = captureOf(match, "name");
      const body = captureOf(match, "body");
      if (!name || name.startLine === undefined || name.startIndex === undefined) continue;
      declarations.push({
        file,
        name: name.text,
        startLine: name.startLine,
        endLine: body?.endLine ?? name.endLine ?? name.startLine,
        startIndex: name.startIndex,
      });
    }
  }
  return declarations;
};

const enclosingClass = (declarations: readonly ClassDeclaration[], file: string, line: number): ClassDeclaration | undefined =>
  declarations.find((declaration) => declaration.file === file && line >= declaration.startLine && line <= declaration.endLine);

const classSymbol = (declaration: ClassDeclaration, file: string): SemanticRelationSymbol => ({
  id: `python:repository:${file}:${declaration.name}`,
  name: declaration.name,
  kind: "class",
  scope: "repository",
  file,
  line: declaration.startLine,
});

const resolveTarget = (
  cwd: string,
  declarations: readonly ClassDeclaration[],
  uri: string,
  line: number,
): PythonTarget | undefined => {
  const file = relationRepositoryPath(cwd, uri);
  if (!file) return undefined;
  const absolute = resolve(cwd, file);
  const exact = declarations.find((declaration) => declaration.file === absolute && declaration.startLine === line);
  const byRange = exact ?? declarations.find((declaration) => declaration.file === absolute && line >= declaration.startLine && line <= declaration.endLine);
  return byRange ? { declaration: byRange, file } : undefined;
};

const collectPythonCandidates = async (
  parser: ParserService,
  files: readonly string[],
  declarations: readonly ClassDeclaration[],
  sources: ReadonlyMap<string, string>,
): Promise<readonly RelationCandidate[]> => {
  const candidates: RelationCandidate[] = [];
  const classNames = new Set(declarations.map((declaration) => declaration.name));
  const pushMatches = (
    file: string,
    matches: readonly QueryMatch[],
    kind: SemanticRelationFact["kind"],
    sourceOf: (match: QueryMatch) => ClassDeclaration | undefined,
  ): void => {
    for (const match of matches) {
      const typeRef = captureOf(match, "typeRef");
      if (!typeRef || typeRef.startIndex === undefined || typeRef.endIndex === undefined || typeRef.startLine === undefined) continue;
      if (kind === "instantiates" && !classNames.has(typeRef.text)) continue;
      const source = sourceOf(match);
      if (kind !== "extends" && !source) continue;
      candidates.push({
        kind, file,
        line: typeRef.startLine,
        typeRef: typeRef.text,
        startIndex: lastIdentifierOffset(sources.get(file)!, typeRef.startIndex, typeRef.endIndex),
        endIndex: typeRef.endIndex,
        ...(source ? { source } : {}),
      });
    }
  };

  for (const file of files) {
    const classDecls = declarations.filter((declaration) => declaration.file === file);
    const sourceForName = (name: string): ClassDeclaration | undefined => classDecls.find((declaration) => declaration.name === name);
    const enclosing = (line: number): ClassDeclaration | undefined => enclosingClass(classDecls, file, line);
    const [bases, parameters, returns, fields, instantiates] = await Effect.runPromise(Effect.all([
      parser.query(file, BASE_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
      parser.query(file, PARAMETER_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
      parser.query(file, RETURN_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
      parser.query(file, FIELD_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
      parser.query(file, INSTANTIATE_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
    ]));
    pushMatches(file, bases, "extends", (match) => {
      const name = captureOf(match, "className")?.text;
      return name ? sourceForName(name) : undefined;
    });
    pushMatches(file, parameters, "parameter_type", (match) => enclosing(captureOf(match, "typeRef")?.startLine ?? -1));
    pushMatches(file, returns, "return_type", (match) => enclosing(captureOf(match, "typeRef")?.startLine ?? -1));
    pushMatches(file, fields, "field_type", (match) => enclosing(captureOf(match, "typeRef")?.startLine ?? -1));
    pushMatches(file, instantiates, "instantiates", (match) => enclosing(captureOf(match, "typeRef")?.startLine ?? -1));
  }
  return candidates;
};

const resolvePythonCandidate = async (
  session: LspSession,
  candidate: RelationCandidate,
  ctx: { readonly cwd: string; readonly sources: ReadonlyMap<string, string>; readonly declarations: readonly ClassDeclaration[] },
): Promise<readonly PythonTarget[]> => {
  const response = await session.request("textDocument/definition", {
    textDocument: { uri: pathToFileURL(candidate.file).href },
    position: relationPositionForOffset(ctx.sources.get(candidate.file)!, candidate.startIndex),
  }, LSP_REQUEST_TIMEOUT_MS);
  return relationDefinitionLocations(response).flatMap(({ file: uri, line }) => {
    const target = resolveTarget(ctx.cwd, ctx.declarations, uri, line);
    return target ? [target] : [];
  });
};

const pythonKernel: LspResolutionKernel<ClassDeclaration, RelationCandidate, PythonTarget> = {
  id: "python-pyright-semantic-relations",
  displayName: "pyright",
  language: "python",
  providerId: "python-pyright-semantic-relations",
  languageId: "python",
  diagnosticsMode: "always",
  launch: relationLaunchForNodeEntry,
  collectDeclarations: classDeclarations,
  collectCandidates: collectPythonCandidates,
  resolveCandidate: resolvePythonCandidate,
  shouldResolve: (candidate) => candidate.source !== undefined,
  sourceFileOf: (candidate) => candidate.file,
  sourceDeclarationOf: (candidate) => candidate.source!,
  offsetOf: (candidate) => candidate.startIndex,
  lineOf: (candidate) => candidate.line,
  targetFileOf: (target) => target.file,
  sourceSymbol: (source, file) => classSymbol(source, file),
  targetSymbol: (target, file) => classSymbol(target.declaration, file),
  factOf: (candidate, source, target, file, line): SemanticRelationFact => ({
    language: "python",
    kind: candidate.kind,
    source,
    target,
    direct: true,
    evidence: { file, line },
  }),
  workspaceRisks: (cwd) => pyrightWorkspaceRisks({ cwd }),
  isComplete: (stats, diagnosticsReady, risks, warmupIncomplete, candidates, _readinessReady) => {
    const requestComplete = candidates.length === 0
      ? diagnosticsReady
      : stats.unresolved === 0 && stats.resolved === candidates.length && stats.targetCount > 0;
    return requestComplete && !warmupIncomplete && risks.length === 0;
  },
  partialReasons: (stats, diagnosticsReady, risks, warmupIncomplete, candidates, _readinessReady) => [
    ...(candidates.length === 0 && !diagnosticsReady ? ["pyright diagnostics readiness did not complete"] : []),
    ...(warmupIncomplete ? ["some documentSymbol warmup requests failed"] : []),
    ...risks,
    ...(stats.unresolved > 0 ? [`${stats.unresolved} definition requests failed`] : []),
    ...(candidates.length > 0 && stats.resolved > 0 && stats.targetCount === 0 ? ["no candidate definition resolved to a repository target"] : []),
  ],
};

export const collectPythonSemanticRelations = (
  input: SemanticRelationRequest,
  runtime: PythonSemanticRelationRuntime,
): Effect.Effect<SemanticRelationReport, never> =>
  Effect.gen(function* () {
    const parser = runtime.parser;
    if (!parser) return {
      origin: { language: "python", providerId: "python-pyright-semantic-relations", evidenceSource: "lsp" },
      state: { availability: "unavailable", coverage: { symbols: "unavailable", relations: "unavailable" }, reason: "ParserService is unavailable" },
      facts: [],
    } satisfies SemanticRelationReport;
    return yield* Effect.promise(() => runLspResolutionPipeline({
      cwd: input.cwd,
      parser,
      runtime: { ...runtime, executable: runtime.executable },
      kernel: pythonKernel,
    }));
  });

export const pythonSemanticRelationProvider: SemanticRelationProvider = {
  id: "python-pyright-semantic-relations",
  evidenceSource: "lsp",
  languages: ["python"],
  requiredToolchains: ["pyright"],
  collect: (input, context) => collectPythonSemanticRelations(input, {
    parser: context.parser,
    executable: context.toolchains.get("pyright")?.executable,
  }),
};
