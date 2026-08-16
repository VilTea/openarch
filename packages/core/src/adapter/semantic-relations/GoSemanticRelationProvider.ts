import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
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
  warmupRelationDocuments,
  relationPositionForOffset,
  relationRelativeFile,
  relationRepositoryPath,
  relationDefinitionLocations,
} from "./relationLsp";

const DIAGNOSTIC_READINESS_TIMEOUT_MS = Number(process.env.OPENARCH_LSP_INDEX_TIMEOUT_MS ?? 180_000);
const LSP_REQUEST_TIMEOUT_MS = Number(process.env.OPENARCH_LSP_REQUEST_TIMEOUT_MS ?? 120_000);

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
  readonly source?: GoTypeDeclaration;
}

export interface GoSemanticRelationRuntime {
  readonly parser?: ParserService;
  readonly executable?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly startSession?: (launch: LspLaunchSpec, cwd: string) => LspSession | Promise<LspSession>;
}

interface GoResolutionContext {
  readonly cwd: string;
  readonly executable: string;
  readonly files: readonly string[];
  readonly sources: ReadonlyMap<string, string>;
  readonly declarations: readonly GoTypeDeclaration[];
  readonly candidates: readonly RelationCandidate[];
  readonly runtime: GoSemanticRelationRuntime;
}

interface GoResolutionStats {
  resolved: number;
  unresolved: number;
  targetCount: number;
  readonly facts: SemanticRelationFact[];
}

// Go deliberately emits no "implements" relations. Interface satisfaction is
// structural in Go and cannot be proven with a single textDocument/definition
// request; proving it would require type-checking every method set, which is
// outside the bounded direct-static scope of this provider.
//
// Go tree-sitter queries. The Go grammar keeps embedded fields as
// field_declaration nodes without a name child, which is why one query can
// capture both named fields (field_type) and embedded fields (embeds):
// the optional @fieldName capture is absent for embedded fields.
const STRUCT_DECLARATION_QUERY = "(type_spec name: (type_identifier) @name type: (struct_type) @body)";
const INTERFACE_DECLARATION_QUERY = "(type_spec name: (type_identifier) @name type: (interface_type) @body)";
const METHOD_RANGE_QUERY = "[(method_declaration receiver: (parameter_list (parameter_declaration type: (type_identifier) @receiverType))) @method (method_declaration receiver: (parameter_list (parameter_declaration type: (pointer_type (type_identifier) @receiverType)))) @method]";
const STRUCT_FIELD_QUERY = "(type_spec name: (type_identifier) @sourceName type: (struct_type (field_declaration_list (field_declaration name: (field_identifier)? @fieldName type: (type_identifier) @typeRef))))";
const STRUCT_POINTER_FIELD_QUERY = "(type_spec name: (type_identifier) @sourceName type: (struct_type (field_declaration_list (field_declaration name: (field_identifier)? @fieldName type: (pointer_type (type_identifier) @typeRef)))))";
const INTERFACE_EMBED_QUERY = "(type_spec name: (type_identifier) @sourceName type: (interface_type (type_elem (type_identifier) @typeRef)))";
// parameter_type/return_type sources must be repository structs/interfaces.
// Go function_declaration nodes have no enclosing type, so only
// method_declaration nodes with a repository receiver can produce a source.
// Function declarations are therefore not enumerated: they could never emit a
// fact with a struct/interface source.
const METHOD_PARAMETER_QUERY = "[(method_declaration parameters: (parameter_list (parameter_declaration type: (type_identifier) @typeRef))) (method_declaration parameters: (parameter_list (parameter_declaration type: (pointer_type (type_identifier) @typeRef))))]";
const METHOD_RESULT_QUERY = "[(method_declaration result: (type_identifier) @typeRef) (method_declaration result: (pointer_type (type_identifier) @typeRef)) (method_declaration result: (parameter_list (parameter_declaration type: (type_identifier) @typeRef))) (method_declaration result: (parameter_list (parameter_declaration type: (pointer_type (type_identifier) @typeRef))))]";
const INSTANTIATE_QUERY = "(composite_literal type: (type_identifier) @typeRef)";

const captureOf = (match: QueryMatch, name: string): QueryCapture | undefined =>
  match.captures.find((capture) => capture.name === name);

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
      const receiverType = captureOf(match, "receiverType");
      if (!method || method.startLine === undefined || method.endLine === undefined) continue;
      if (!receiverType) continue;
      methods.push({ file, receiverType: receiverType.text, startLine: method.startLine, endLine: method.endLine });
    }
  }
  return methods;
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

const uniqueFacts = (facts: readonly SemanticRelationFact[]): readonly SemanticRelationFact[] => {
  const byIdentity = new Map<string, SemanticRelationFact>();
  for (const fact of facts) {
    byIdentity.set(`${fact.source.id}\0${fact.kind}\0${fact.target.id}\0${fact.evidence.file}\0${fact.evidence.line}`, fact);
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.evidence.file.localeCompare(right.evidence.file)
    || left.evidence.line - right.evidence.line
    || left.kind.localeCompare(right.kind)
    || left.source.id.localeCompare(right.source.id)
    || left.target.id.localeCompare(right.target.id));
};

const resolveTargetDeclaration = (
  cwd: string,
  declarations: readonly GoTypeDeclaration[],
  uri: string,
  line: number,
): { readonly declaration: GoTypeDeclaration; readonly file: string } | undefined => {
  const file = relationRepositoryPath(cwd, uri);
  if (!file) return undefined;
  const absolute = resolve(cwd, file);
  const byRange = declarations.find((declaration) => declaration.file === absolute && line >= declaration.startLine && line <= declaration.endLine);
  return byRange ? { declaration: byRange, file } : undefined;
};

const unavailable = (reason: string): SemanticRelationReport => ({
  origin: { language: "go", providerId: "go-gopls-semantic-relations", evidenceSource: "lsp" },
  state: { availability: "unavailable", coverage: { symbols: "unavailable", relations: "unavailable" }, reason },
  facts: [],
});

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

    // Embedded fields have no @fieldName capture; named fields are field_type.
    // This applies to both plain (`Service`) and pointer (`*Other`) embedded
    // fields, because Go treats an embedded pointer field as an embedded type.
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

const resolveGoCandidate = async (
  ctx: GoResolutionContext,
  session: LspSession,
  stats: GoResolutionStats,
  candidate: RelationCandidate,
): Promise<void> => {
  const sourceDeclaration = candidate.source;
  if (!sourceDeclaration) return;
  const position = relationPositionForOffset(ctx.sources.get(candidate.file)!, candidate.startIndex);
  let targets: readonly { readonly declaration: GoTypeDeclaration; readonly file: string }[] = [];
  try {
    const response = await session.request("textDocument/definition", {
      textDocument: { uri: pathToFileURL(candidate.file).href },
      position,
    }, LSP_REQUEST_TIMEOUT_MS);
    stats.resolved += 1;
    targets = relationDefinitionLocations(response).flatMap(({ file: uri, line }) => {
      const target = resolveTargetDeclaration(ctx.cwd, ctx.declarations, uri, line);
      return target ? [target] : [];
    });
    stats.targetCount += targets.length;
  } catch {
    stats.unresolved += 1;
  }
  const sourceFile = relationRelativeFile(ctx.cwd, sourceDeclaration.file);
  const source = symbolFor(sourceDeclaration, sourceFile);
  for (const target of targets) {
    stats.facts.push({
      language: "go",
      kind: candidate.kind,
      source,
      target: symbolFor(target.declaration, target.file),
      direct: true,
      evidence: { file: relationRelativeFile(ctx.cwd, candidate.file), line: candidate.line },
    });
  }
};

const resolveGoCandidatePool = async (
  ctx: GoResolutionContext,
  session: LspSession,
  stats: GoResolutionStats,
): Promise<void> => {
  const DEFINITION_CONCURRENCY = 12;
  let nextCandidate = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextCandidate;
      nextCandidate += 1;
      if (index >= ctx.candidates.length) return;
      await resolveGoCandidate(ctx, session, stats, ctx.candidates[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DEFINITION_CONCURRENCY, ctx.candidates.length) }, () => worker()));
};

const resolveGoSemanticRelations = async (ctx: GoResolutionContext): Promise<SemanticRelationReport> => {
  // gopls 原生支持 -remote=auto 的常驻 daemon（客户端代理 + 空闲回收），
  // 不需要 jdtls 式转发 daemon；关闭客户端只杀 proxy，保留 gopls daemon。
  const args = process.env.OPENARCH_GOPLS_DAEMON === "off" ? ["serve"] : ["-remote=auto"];
  const launch = {
    command: ctx.executable,
    args: args as readonly string[],
    shutdown: (process.env.OPENARCH_GOPLS_DAEMON === "off" ? "tree" : "self") as "tree" | "self",
    ...(ctx.runtime.environment ? { environment: ctx.runtime.environment } : {}),
  };
  let session: LspSession;
  try {
    session = await (ctx.runtime.startSession ?? defaultRelationStartSession)(launch, ctx.cwd);
  } catch (error) {
    return unavailable(`failed to start gopls: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    try {
      await initializeRelationWorkspace(session, ctx.cwd, "definitionProvider");
    } catch (error) {
      return unavailable(`failed to initialize gopls: ${error instanceof Error ? error.message : String(error)}`);
    }
    openRelationDocuments(session, ctx.files, "go");
    debugLog("warmup start");
    // gopls -remote=auto 由常驻 daemon 维护索引，逐文件 documentSymbol 预热
    // 在 proxy 上反而放大耗时；单次 serve 模式仍保留预热。
    const nativeRemote = process.env.OPENARCH_GOPLS_DAEMON !== "off";
    const warmupIncomplete = nativeRemote ? false : await warmupRelationDocuments(session, ctx.files, LSP_REQUEST_TIMEOUT_MS);
    debugLog(`warmup done incomplete=${warmupIncomplete}`);
    // gopls answers definition queries only after its workspace index is
    // ready; unlike small samples, large Go modules return empty/error
    // responses before diagnostics are published. Always wait for
    // diagnostics when available, then still collect on timeout as partial.
    const diagnosticsReady = session.waitForDiagnostics
      ? await session.waitForDiagnostics(ctx.files.map((file) => pathToFileURL(file).href), DIAGNOSTIC_READINESS_TIMEOUT_MS).catch(() => false)
      : true;
    const risks = goWorkspaceRisks(ctx.cwd);
    const stats: GoResolutionStats = { resolved: 0, unresolved: 0, targetCount: 0, facts: [] };
    debugLog("definition start");
    // gopls handles concurrent definition requests after its initial load.
    // A bounded pool keeps large workspaces inside the integration budget;
    // sequential requests were measured at ~300ms each on 800+ candidates.
    await resolveGoCandidatePool(ctx, session, stats);
    debugLog(`definition done resolved=${stats.resolved} unresolved=${stats.unresolved} targetCount=${stats.targetCount} facts=${stats.facts.length}`);

    // Same coverage contract as the Python provider: with candidates, every
    // definition request must succeed and at least one repository target must
    // resolve; without candidates, diagnostic readiness is the only gate.
    const requestComplete = stats.unresolved === 0 && stats.resolved === ctx.candidates.length && stats.targetCount > 0;
    const complete = requestComplete && diagnosticsReady && !warmupIncomplete && risks.length === 0;
    return {
      origin: { language: "go", providerId: "go-gopls-semantic-relations", evidenceSource: "lsp" },
      state: {
        availability: complete ? "available" : "partial",
        coverage: {
          symbols: complete ? "complete" : "partial",
          relations: complete ? "complete" : "partial",
        },
        ...(complete ? {} : { reason: [
          ...(!diagnosticsReady ? ["gopls diagnostics readiness did not complete"] : []),
          ...(warmupIncomplete ? ["some documentSymbol warmup requests failed"] : []),
          ...risks,
          ...(stats.unresolved > 0 ? [`${stats.unresolved} definition requests failed`] : []),
          ...(ctx.candidates.length > 0 && stats.resolved > 0 && stats.targetCount === 0 ? ["no candidate definition resolved to a repository target"] : []),
        ].join("; ") }),
      },
      facts: uniqueFacts(stats.facts),
    };
  } finally {
    await Promise.resolve(session.close());
  }
};

export const collectGoSemanticRelations = (
  input: SemanticRelationRequest,
  runtime: GoSemanticRelationRuntime,
): Effect.Effect<SemanticRelationReport, never> =>
  Effect.gen(function* () {
    const parser = runtime.parser;
    const executable = runtime.executable;
    if (!parser) return unavailable("ParserService is unavailable");
    if (!executable) return unavailable("gopls executable is unavailable; configure the go toolchain");
    const files = listProjectSourceFiles({ cwd: input.cwd, languages: ["go"], population: "production-governance" });
    debugLog(`files=${files.length}`);
    if (files.length === 0) return unavailable("no governed Go source files");

    const declarations = yield* Effect.promise(() => collectTypeDeclarations(parser, files));
    const methods = yield* Effect.promise(() => collectMethodDeclarations(parser, files));
    debugLog(`declarations=${declarations.length} methods=${methods.length}`);
    const sources = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
    const candidates = yield* Effect.promise(() => collectGoCandidates(parser, files, declarations, methods));
    debugLog(`candidates=${candidates.length}`);
    return yield* Effect.promise(() => resolveGoSemanticRelations({ cwd: input.cwd, executable, files, sources, declarations, candidates, runtime }));
  });

export const goSemanticRelationProvider: SemanticRelationProvider = {
  id: "go-gopls-semantic-relations",
  evidenceSource: "lsp",
  languages: ["go"],
  requiredToolchains: ["gopls"],
  collect: (input, context) => {
    const gopls = context.toolchains.get("gopls");
    // gopls shells out to the Go command; prefer configured toolchain env and
    // fall back to injecting the discovered go executable directory into PATH,
    // mirroring go-gopls-symbol-use. "go" is deliberately optional here.
    const go = context.toolchains.get("go");
    const configuredEnv = gopls?.env ?? go?.env;
    const environment = go?.executable
      ? { ...process.env, ...configuredEnv, PATH: [dirname(go.executable), process.env.PATH].filter(Boolean).join(delimiter) }
      : configuredEnv
        ? { ...process.env, ...configuredEnv }
        : undefined;
    return collectGoSemanticRelations(input, {
      parser: context.parser,
      executable: gopls?.executable,
      ...(environment ? { environment } : {}),
    });
  },
};
