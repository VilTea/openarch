import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect } from "effect";
import type { ParserService, QueryCapture, QueryMatch } from "../../port/ParserService";
import type { LspLaunchSpec, LspSession } from "../lsp/NodeLspSession";
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
import { listProjectSourceFiles } from "../../projectFiles";
import type { SemanticRelationProvider, SemanticRelationRequest } from "../../semantic-relations/provider";
import type { SemanticRelationFact, SemanticRelationReport, SemanticRelationSymbol } from "../../semantic-relations/types";

const DIAGNOSTIC_READINESS_TIMEOUT_MS = Number(process.env.OPENARCH_LSP_INDEX_TIMEOUT_MS ?? 180_000);
const LSP_REQUEST_TIMEOUT_MS = Number(process.env.OPENARCH_LSP_REQUEST_TIMEOUT_MS ?? 120_000);

type RustSymbolKind = "struct" | "enum" | "trait";

interface RustDeclaration {
  readonly file: string;
  readonly name: string;
  readonly kind: RustSymbolKind;
  readonly qualifiedName: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startIndex: number;
}

interface RustImpl {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly typeRef: QueryCapture;
  readonly traitRef?: QueryCapture;
}

interface TypeAnchor {
  readonly name: string;
  readonly startIndex: number;
}

interface RelationCandidate {
  readonly kind: SemanticRelationFact["kind"];
  readonly file: string;
  readonly line: number;
  readonly target: TypeAnchor;
  readonly source?: RustDeclaration;
  readonly sourceImpl?: RustImpl;
}

interface RustModuleRange {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
}

interface RustCollection {
  readonly declarations: RustDeclaration[];
  readonly candidates: RelationCandidate[];
  readonly workspaceRisks: string[];
}

interface RustResolutionContext {
  readonly cwd: string;
  readonly executable: string;
  readonly files: readonly string[];
  readonly sources: ReadonlyMap<string, string>;
  readonly declarations: readonly RustDeclaration[];
  readonly candidates: readonly RelationCandidate[];
  readonly workspaceRisks: readonly string[];
  readonly runtime: RustSemanticRelationRuntime;
}

interface RustResolutionStats {
  failedRequests: number;
  requestedCandidateTargets: number;
  skippedWithoutImplSource: number;
  skippedImplementsSourceKind: number;
  readonly facts: SemanticRelationFact[];
}

export interface RustSemanticRelationRuntime {
  readonly parser?: ParserService;
  readonly executable?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly startSession?: (launch: LspLaunchSpec, cwd: string) => LspSession | Promise<LspSession>;
}

const DECLARATION_QUERY = "[(struct_item name: (type_identifier) @name) @struct (enum_item name: (type_identifier) @name) @enum (trait_item name: (type_identifier) @name) @trait]";
const MODULE_QUERY = "(mod_item name: (identifier) @modName body: (declaration_list) @modBody)";
const IMPL_QUERY = "(impl_item type: (_) @typeRef) @impl";
const TRAIT_IMPL_QUERY = "(impl_item trait: (_) @traitRef type: (_) @typeRef) @impl";
const FIELD_QUERY = "(field_declaration name: (field_identifier) @fieldName type: (_) @typeRef)";
const PARAMETER_QUERY = "(function_item parameters: (parameters (parameter type: (_) @typeRef)))";
const RETURN_QUERY = "(function_item return_type: (_) @typeRef)";
const STRUCT_EXPRESSION_QUERY = "(struct_expression name: (type_identifier) @typeRef)";
const MACRO_QUERY = "(macro_invocation) @macro";
const ATTR_IDENTIFIER_QUERY = "(attribute_item (attribute (identifier) @name))";
const ATTR_SCOPED_QUERY = "(attribute_item (attribute (scoped_identifier) @name))";

const captureOf = (match: QueryMatch, name: string): QueryCapture | undefined =>
  match.captures.find((capture) => capture.name === name);

/**
 * Resolves the type name a definition request must point at. Rust type nodes
 * are a closed set of node types but QueryCapture deliberately does not expose
 * the node type, so the anchor is derived from the captured text:
 * - references/pointers are unwrapped (`&'a mut Request` -> `Request`),
 * - generic arguments are cut at the first `<` (`Vec<u8>` -> `Vec`),
 * - path types keep their last segment (`crate::foo::Bar<T>` -> `Bar`).
 * Structural type forms (tuple/array/function/dyn/impl) cannot name a
 * repository struct/enum/trait directly and are skipped, never guessed.
 */
const typeAnchorFor = (source: string, capture: QueryCapture): TypeAnchor | undefined => {
  const startIndex = capture.startIndex;
  if (startIndex === undefined || capture.endIndex === undefined) return undefined;
  const original = capture.text;
  if (!original.trim()) return undefined;
  if (/^(\(|\[|!|fn\b|dyn\b|impl\b)/.test(original.trim())) return undefined;
  let body = original;
  let removed = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    const stripped = body
      .replace(/^&\s*(?:'[A-Za-z_][A-Za-z0-9_]*\s*)?(?:mut\s+)?/, "")
      .replace(/^\*\s*(?:const|mut)\s*/, "");
    if (stripped === body) break;
    removed += body.length - stripped.length;
    body = stripped;
  }
  if (!body.trim()) return undefined;
  const genericAt = body.indexOf("<");
  const rawHead = genericAt >= 0 ? body.slice(0, genericAt) : body;
  const leading = rawHead.length - rawHead.trimStart().length;
  const head = rawHead.slice(leading);
  if (!head || /^(\(|\[|!|fn\b|dyn\b|impl\b|_)/.test(head)) return undefined;
  const lastSeparator = head.lastIndexOf("::");
  const segment = head.slice(lastSeparator + 2);
  const match = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(segment);
  if (!match) return undefined;
  return { name: match[1], startIndex: startIndex + removed + leading + (lastSeparator >= 0 ? lastSeparator + 2 : 0) + match.index };
};

const declarationFor = (
  declarations: readonly RustDeclaration[],
  file: string,
  line: number,
): RustDeclaration | undefined =>
  declarations.find((declaration) => declaration.file === file && line >= declaration.startLine && line <= declaration.endLine);

const implFor = (impls: readonly RustImpl[], file: string, line: number): RustImpl | undefined =>
  impls.find((impl) => impl.file === file && line >= impl.startLine && line <= impl.endLine);

const relativeFile = (cwd: string, file: string): string => relationRelativeFile(cwd, file);

const declarationSymbol = (declaration: RustDeclaration, file: string): SemanticRelationSymbol => ({
  id: `rust:repository:${file}:${declaration.qualifiedName}`,
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

const unavailable = (reason: string): SemanticRelationReport => ({
  origin: { language: "rust", providerId: "rust-rust-analyzer-semantic-relations", evidenceSource: "lsp" },
  state: { availability: "unavailable", coverage: { symbols: "unavailable", relations: "unavailable" }, reason },
  facts: [],
});

const SOURCE_KINDS: readonly RustSymbolKind[] = ["struct", "enum", "trait"];
const TARGET_KINDS: Readonly<Record<SemanticRelationFact["kind"], readonly RustSymbolKind[]>> = {
  implements: ["trait"],
  field_type: ["struct", "enum", "trait"],
  parameter_type: ["struct", "enum", "trait"],
  return_type: ["struct", "enum", "trait"],
  instantiates: ["struct"],
  extends: [],
  embeds: [],
};

/** A bare `impl Type` carries no trait, so it never produces an `implements` fact. */
const implementsSourceKinds: readonly RustSymbolKind[] = ["struct", "enum"];

const queryRust = (parser: ParserService, file: string, pattern: string): Promise<readonly QueryMatch[]> =>
  Effect.runPromise(parser.query(file, pattern).pipe(Effect.catchAll(() => Effect.succeed([]))));

const readCargoWorkspaceRisk = (cargoToml: string): string | undefined => {
  try {
    const manifest = readFileSync(cargoToml, "utf8");
    return /^\s*\[workspace\]/m.test(manifest)
      ? "Cargo workspace manifests are outside the calibrated single-crate semantic-relations scope"
      : undefined;
  } catch {
    return "Rust Cargo.toml could not be read";
  }
};

const collectRustWorkspaceRisks = (
  cwd: string,
  files: readonly string[],
  sources: ReadonlyMap<string, string>,
): string[] => {
  const risks: string[] = [];
  const cargoToml = join(cwd, "Cargo.toml");
  const cargoRisk = existsSync(cargoToml)
    ? readCargoWorkspaceRisk(cargoToml)
    : "Rust semantic relations require a Cargo.toml crate rooted at the governed project";
  risks.push(...(cargoRisk ? [cargoRisk] : []));
  risks.push(...(files.some((file) => basename(file) === "build.rs")
    ? ["Rust build scripts are outside the calibrated semantic-relations scope"]
    : []));
  for (const source of sources.values()) {
    if (/#\s*\[\s*cfg(?:_|\s|\()/.test(source)) {
      risks.push("Rust conditional compilation is outside the calibrated semantic-relations scope");
      break;
    }
  }
  return risks;
};

const moduleRangesFromMatches = (matches: readonly QueryMatch[]): RustModuleRange[] => {
  const ranges: RustModuleRange[] = [];
  for (const match of matches) {
    const name = captureOf(match, "modName");
    const body = captureOf(match, "modBody");
    if (!name || name.startLine === undefined || !body || body.startLine === undefined || body.endLine === undefined) continue;
    ranges.push({ name: name.text, startLine: body.startLine, endLine: body.endLine });
  }
  return ranges;
};

const collectRustDeclarations = (
  file: string,
  matches: readonly QueryMatch[],
  moduleRanges: readonly RustModuleRange[],
): RustDeclaration[] => {
  const declarations: RustDeclaration[] = [];
  for (const match of matches) {
    const name = captureOf(match, "name");
    const item = captureOf(match, "struct") ?? captureOf(match, "enum") ?? captureOf(match, "trait");
    if (!name || !item || name.startLine === undefined || name.startIndex === undefined || item.endLine === undefined) continue;
    const kind: RustSymbolKind = captureOf(match, "struct") ? "struct" : captureOf(match, "enum") ? "enum" : "trait";
    const enclosingModules = moduleRanges
      .filter((module) => name.startLine! >= module.startLine && name.startLine! <= module.endLine)
      .sort((left, right) => left.startLine - right.startLine)
      .map((module) => module.name);
    declarations.push({
      file,
      name: name.text,
      kind,
      qualifiedName: [...enclosingModules, name.text].join("::"),
      startLine: name.startLine,
      endLine: item.endLine,
      startIndex: name.startIndex,
    });
  }
  return declarations;
};

const collectRustImpls = (
  file: string,
  implMatches: readonly QueryMatch[],
  traitImplMatches: readonly QueryMatch[],
): RustImpl[] => {
  const traitRefByType = new Map<string, QueryCapture>();
  for (const match of traitImplMatches) {
    const traitRef = captureOf(match, "traitRef");
    const typeRef = captureOf(match, "typeRef");
    if (!traitRef || !typeRef || typeRef.startIndex === undefined || typeRef.endIndex === undefined) continue;
    traitRefByType.set(`${typeRef.startIndex}:${typeRef.endIndex}`, traitRef);
  }
  const impls: RustImpl[] = [];
  for (const match of implMatches) {
    const item = captureOf(match, "impl");
    const typeRef = captureOf(match, "typeRef");
    if (!item || !typeRef || item.startLine === undefined || item.endLine === undefined) continue;
    const traitRef = typeRef.startIndex !== undefined && typeRef.endIndex !== undefined
      ? traitRefByType.get(`${typeRef.startIndex}:${typeRef.endIndex}`)
      : undefined;
    impls.push(traitRef
      ? { file, startLine: item.startLine, endLine: item.endLine, typeRef, traitRef }
      : { file, startLine: item.startLine, endLine: item.endLine, typeRef });
  }
  return impls;
};

const pushRustDeclarationTargets = (
  candidates: RelationCandidate[],
  file: string,
  sourceText: string,
  matches: readonly QueryMatch[],
  kind: SemanticRelationFact["kind"],
  sourceOf: (match: QueryMatch) => RustDeclaration | undefined,
): void => {
  for (const match of matches) {
    const typeRef = captureOf(match, "typeRef");
    if (!typeRef || typeRef.startLine === undefined) continue;
    const anchor = typeAnchorFor(sourceText, typeRef);
    if (!anchor) continue;
    const source = sourceOf(match);
    if (!source) continue;
    candidates.push({ kind, file, line: typeRef.startLine, target: anchor, source });
  }
};

const pushRustImplTargets = (
  candidates: RelationCandidate[],
  file: string,
  sourceText: string,
  matches: readonly QueryMatch[],
  kind: SemanticRelationFact["kind"],
  sourceOf: (match: QueryMatch) => RustImpl | undefined,
): void => {
  for (const match of matches) {
    const typeRef = captureOf(match, "typeRef");
    if (!typeRef || typeRef.startLine === undefined) continue;
    const anchor = typeAnchorFor(sourceText, typeRef);
    if (!anchor) continue;
    const impl = sourceOf(match);
    if (!impl || !typeAnchorFor(sourceText, impl.typeRef)) continue;
    candidates.push({ kind, file, line: typeRef.startLine, target: anchor, sourceImpl: impl });
  }
};

const pushRustImplementsTargets = (
  candidates: RelationCandidate[],
  file: string,
  sourceText: string,
  impls: readonly RustImpl[],
  matches: readonly QueryMatch[],
): void => {
  for (const match of matches) {
    const traitRef = captureOf(match, "traitRef");
    const typeRef = captureOf(match, "typeRef");
    if (!traitRef || !typeRef || traitRef.startLine === undefined || typeRef.startIndex === undefined || typeRef.endIndex === undefined) continue;
    const target = typeAnchorFor(sourceText, traitRef);
    if (!target) continue;
    const impl = impls.find((entry) =>
      entry.typeRef.startIndex === typeRef.startIndex && entry.typeRef.endIndex === typeRef.endIndex);
    if (!impl || !typeAnchorFor(sourceText, impl.typeRef)) continue;
    candidates.push({ kind: "implements", file, line: traitRef.startLine, target, sourceImpl: impl });
  }
};

const collectRustCandidates = async (
  parser: ParserService,
  cwd: string,
  files: readonly string[],
  sources: ReadonlyMap<string, string>,
): Promise<RustCollection> => {
  const workspaceRisks = collectRustWorkspaceRisks(cwd, files, sources);
  const declarations: RustDeclaration[] = [];
  const candidates: RelationCandidate[] = [];
  for (const file of files) {
    const [moduleMatches, declarationMatches, implMatches, traitImplMatches, fieldMatches, parameterMatches, returnMatches, structExpressionMatches, macroMatches, attrIdentifierMatches, attrScopedMatches] = await Promise.all([
      queryRust(parser, file, MODULE_QUERY),
      queryRust(parser, file, DECLARATION_QUERY),
      queryRust(parser, file, IMPL_QUERY),
      queryRust(parser, file, TRAIT_IMPL_QUERY),
      queryRust(parser, file, FIELD_QUERY),
      queryRust(parser, file, PARAMETER_QUERY),
      queryRust(parser, file, RETURN_QUERY),
      queryRust(parser, file, STRUCT_EXPRESSION_QUERY),
      queryRust(parser, file, MACRO_QUERY),
      queryRust(parser, file, ATTR_IDENTIFIER_QUERY),
      queryRust(parser, file, ATTR_SCOPED_QUERY),
    ]);

    if (macroMatches.length > 0) {
      workspaceRisks.push("Rust macro expansion is outside the calibrated semantic-relations scope");
    }
    if (attrIdentifierMatches.some((match) => {
      const name = captureOf(match, "name")?.text;
      return name !== undefined && ["derive", "proc_macro", "proc_macro_attribute", "proc_macro_derive"].includes(name);
    })) {
      workspaceRisks.push("Rust derive or proc-macro expansion is outside the calibrated semantic-relations scope");
    }
    if (attrScopedMatches.length > 0) {
      workspaceRisks.push("Rust path attribute macros are outside the calibrated semantic-relations scope");
    }

    const moduleRanges = moduleRangesFromMatches(moduleMatches);
    const fileDeclarations = collectRustDeclarations(file, declarationMatches, moduleRanges);
    declarations.push(...fileDeclarations);
    const fileImpls = collectRustImpls(file, implMatches, traitImplMatches);
    const sourceText = sources.get(file)!;
    const structDeclarations = fileDeclarations.filter((declaration) => declaration.kind === "struct");
    const enclosingStruct = (line: number): RustDeclaration | undefined => declarationFor(structDeclarations, file, line);
    const enclosingImpl = (line: number): RustImpl | undefined => implFor(fileImpls, file, line);

    pushRustDeclarationTargets(candidates, file, sourceText, fieldMatches, "field_type", (match) => enclosingStruct(captureOf(match, "typeRef")?.startLine ?? -1));
    pushRustImplTargets(candidates, file, sourceText, parameterMatches, "parameter_type", (match) => enclosingImpl(captureOf(match, "typeRef")?.startLine ?? -1));
    pushRustImplTargets(candidates, file, sourceText, returnMatches, "return_type", (match) => enclosingImpl(captureOf(match, "typeRef")?.startLine ?? -1));
    pushRustImplTargets(candidates, file, sourceText, structExpressionMatches, "instantiates", (match) => enclosingImpl(captureOf(match, "typeRef")?.startLine ?? -1));
    pushRustImplementsTargets(candidates, file, sourceText, fileImpls, traitImplMatches);
  }
  return { declarations, candidates, workspaceRisks };
};

const canonicalWorkspaceUri = (uri: string): string => {
  try {
    const canonical = pathToFileURL(realpathSync.native(fileURLToPath(uri))).href;
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  } catch {
    return process.platform === "win32" ? uri.toLowerCase() : uri;
  }
};

const waitForRustDefinitionIndex = async (
  session: LspSession,
  declarations: readonly RustDeclaration[],
  candidates: readonly RelationCandidate[],
  warmupIncomplete: boolean,
): Promise<boolean> => {
  if (candidates.length === 0 || warmupIncomplete) return true;
  const declaredNames = new Set(declarations.map((declaration) => declaration.name));
  const probeCandidate = candidates.find((candidate) => declaredNames.has(candidate.target.name)) ?? candidates[0];
  const probeDeclaration = probeCandidate
    ? declarations.find((declaration) => declaration.name === probeCandidate.target.name) ?? declarations[0]
    : declarations[0];
  if (!probeDeclaration) return true;
  const probeUri = canonicalWorkspaceUri(pathToFileURL(probeDeclaration.file).href);
  const deadline = Date.now() + DIAGNOSTIC_READINESS_TIMEOUT_MS;
  for (;;) {
    try {
      const symbols = await session.request<readonly { name?: string; location?: { uri?: string } }[]>(
        "workspace/symbol",
        { query: probeDeclaration.name },
        Math.min(30_000, Math.max(1_000, deadline - Date.now())),
      );
      const ready = (symbols ?? []).some((symbol) =>
        symbol.name === probeDeclaration.name
        && symbol.location?.uri !== undefined
        && canonicalWorkspaceUri(symbol.location.uri) === probeUri);
      if (ready) return true;
    } catch {
      return true; // workspace/symbol unsupported or failed: do not block definition resolution
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
};

const resolveRustDefinition = async (
  session: LspSession,
  ctx: RustResolutionContext,
  stats: RustResolutionStats,
  file: string,
  anchor: TypeAnchor,
): Promise<readonly RustDeclaration[]> => {
  try {
    const response = await session.request("textDocument/definition", {
      textDocument: { uri: pathToFileURL(file).href },
      position: relationPositionForOffset(ctx.sources.get(file)!, anchor.startIndex),
    }, LSP_REQUEST_TIMEOUT_MS);
    return relationDefinitionLocations(response).flatMap(({ file: uri, line }) => {
      const repositoryFile = relationRepositoryPath(ctx.cwd, uri);
      if (!repositoryFile) return [];
      const declaration = declarationFor(ctx.declarations, resolve(ctx.cwd, repositoryFile), line);
      return declaration ? [declaration] : [];
    });
  } catch {
    stats.failedRequests += 1;
    return [];
  }
};

const resolveRustImplSource = async (
  session: LspSession,
  ctx: RustResolutionContext,
  stats: RustResolutionStats,
  cache: Map<string, RustDeclaration | undefined>,
  impl: RustImpl,
): Promise<RustDeclaration | undefined> => {
  const key = `${impl.file}:${impl.typeRef.startIndex}:${impl.typeRef.endIndex}`;
  if (cache.has(key)) return cache.get(key);
  const anchor = typeAnchorFor(ctx.sources.get(impl.file)!, impl.typeRef);
  if (!anchor) {
    cache.set(key, undefined);
    return undefined;
  }
  const targets = await resolveRustDefinition(session, ctx, stats, impl.file, anchor);
  const declaration = targets.find((target) => SOURCE_KINDS.includes(target.kind));
  cache.set(key, declaration);
  return declaration;
};

const resolveRustCandidate = async (
  session: LspSession,
  ctx: RustResolutionContext,
  stats: RustResolutionStats,
  cache: Map<string, RustDeclaration | undefined>,
  candidate: RelationCandidate,
): Promise<void> => {
  const sourceDecl = candidate.source ?? await resolveRustImplSource(session, ctx, stats, cache, candidate.sourceImpl!);
  if (!sourceDecl) {
    stats.skippedWithoutImplSource += 1;
    return;
  }
  if (candidate.kind === "implements" && !implementsSourceKinds.includes(sourceDecl.kind)) {
    stats.skippedImplementsSourceKind += 1;
    return;
  }
  stats.requestedCandidateTargets += 1;
  const targets = await resolveRustDefinition(session, ctx, stats, candidate.file, candidate.target);
  const sourceFile = relativeFile(ctx.cwd, sourceDecl.file);
  const source = declarationSymbol(sourceDecl, sourceFile);
  for (const target of targets) {
    if (!TARGET_KINDS[candidate.kind].includes(target.kind)) continue;
    stats.facts.push({
      language: "rust",
      kind: candidate.kind,
      source,
      target: declarationSymbol(target, relativeFile(ctx.cwd, target.file)),
      direct: true,
      evidence: { file: relativeFile(ctx.cwd, candidate.file), line: candidate.line },
    });
  }
};

const startRustSession = async (ctx: RustResolutionContext): Promise<LspSession | SemanticRelationReport> => {
  const launch = { ...relationLaunch(ctx.executable), ...(ctx.runtime.environment ? { environment: ctx.runtime.environment } : {}) };
  try {
    return await (ctx.runtime.startSession ?? defaultRelationStartSession)(launch, ctx.cwd);
  } catch (error) {
    return unavailable(`failed to start rust-analyzer: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const initializeRustSession = async (session: LspSession, cwd: string): Promise<SemanticRelationReport | undefined> => {
  try {
    await initializeRelationWorkspace(session, cwd, "definitionProvider");
    return undefined;
  } catch (error) {
    return unavailable(`failed to initialize rust-analyzer: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const collectWithRustSession = async (session: LspSession, ctx: RustResolutionContext): Promise<SemanticRelationReport> => {
  try {
    const initFailure = await initializeRustSession(session, ctx.cwd);
    if (initFailure) return initFailure;
    openRelationDocuments(session, ctx.files, "rust");
    // rust-analyzer indexes opened files on documentSymbol requests; this
    // mirrors the Python provider so diagnostics readiness observes a real index.
    const warmupIncomplete = await warmupRelationDocuments(session, ctx.files, LSP_REQUEST_TIMEOUT_MS);
    const uris = ctx.files.map((file) => pathToFileURL(file).href);
    // Diagnostic readiness only gates an empty candidate set; with candidates,
    // successful definition requests prove the index is usable.
    let diagnosticsReady = true;
    if (ctx.candidates.length === 0 && session.waitForDiagnostics) {
      diagnosticsReady = await session.waitForDiagnostics(uris, DIAGNOSTIC_READINESS_TIMEOUT_MS).catch(() => false);
    }
    // rust-analyzer's publishDiagnostics arrives before the crate index can
    // answer textDocument/definition; poll workspace/symbol until the exact
    // probe declaration file appears so a not-ready empty result is never
    // cached as a real "no target".
    const definitionIndexReady = await waitForRustDefinitionIndex(session, ctx.declarations, ctx.candidates, warmupIncomplete);
    const stats: RustResolutionStats = { failedRequests: 0, requestedCandidateTargets: 0, skippedWithoutImplSource: 0, skippedImplementsSourceKind: 0, facts: [] };
    const implSourceCache = new Map<string, RustDeclaration | undefined>();
    for (const candidate of ctx.candidates) {
      await resolveRustCandidate(session, ctx, stats, implSourceCache, candidate);
    }

    const risks = [...new Set(ctx.workspaceRisks)];
    const requestComplete = ctx.candidates.length === 0
      ? diagnosticsReady
      : stats.failedRequests === 0 && stats.requestedCandidateTargets === ctx.candidates.length && stats.facts.length > 0;
    const complete = requestComplete && definitionIndexReady && !warmupIncomplete && risks.length === 0;
    return {
      origin: { language: "rust", providerId: "rust-rust-analyzer-semantic-relations", evidenceSource: "lsp" },
      state: {
        availability: complete ? "available" : "partial",
        coverage: {
          symbols: complete ? "complete" : "partial",
          relations: complete ? "complete" : "partial",
        },
        ...(complete ? {} : { reason: [
          ...(ctx.candidates.length === 0 && !diagnosticsReady ? ["rust-analyzer diagnostics readiness did not complete"] : []),
          ...(ctx.candidates.length > 0 && !definitionIndexReady ? ["rust-analyzer definition index readiness did not complete"] : []),
          ...(warmupIncomplete ? ["some documentSymbol warmup requests failed"] : []),
          ...risks,
          ...(stats.failedRequests > 0 ? [`${stats.failedRequests} definition request(s) failed`] : []),
          ...(stats.skippedWithoutImplSource > 0 ? [`${stats.skippedWithoutImplSource} candidate(s) skipped because their impl source did not resolve to a repository struct/enum/trait`] : []),
          ...(stats.skippedImplementsSourceKind > 0 ? [`${stats.skippedImplementsSourceKind} implements candidate(s) skipped because the impl source is not a repository struct/enum`] : []),
          ...(ctx.candidates.length > 0 && stats.facts.length === 0 ? ["no candidate definition resolved to a repository target"] : []),
        ].join("; ") }),
      },
      facts: uniqueFacts(stats.facts),
    };
  } finally {
    await Promise.resolve(session.close());
  }
};

const resolveRustSemanticRelations = async (ctx: RustResolutionContext): Promise<SemanticRelationReport> => {
  const session = await startRustSession(ctx);
  if (!("request" in session)) return session;
  return collectWithRustSession(session, ctx);
};

export const collectRustSemanticRelations = (
  input: SemanticRelationRequest,
  runtime: RustSemanticRelationRuntime,
): Effect.Effect<SemanticRelationReport, never> =>
  Effect.gen(function* () {
    const parser = runtime.parser;
    const executable = runtime.executable;
    if (!parser) return unavailable("ParserService is unavailable");
    if (!executable) return unavailable("rust-analyzer executable is unavailable; configure the rust toolchain");
    const files = listProjectSourceFiles({ cwd: input.cwd, languages: ["rust"], population: "production-governance" });
    if (files.length === 0) return unavailable("no governed Rust source files");

    const sources = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
    const { declarations, candidates, workspaceRisks } = yield* Effect.promise(() => collectRustCandidates(parser, input.cwd, files, sources));
    return yield* Effect.promise(() => resolveRustSemanticRelations({ cwd: input.cwd, executable, files, sources, declarations, candidates, workspaceRisks, runtime }));
  });

export const rustSemanticRelationProvider: SemanticRelationProvider = {
  id: "rust-rust-analyzer-semantic-relations",
  evidenceSource: "lsp",
  languages: ["rust"],
  requiredToolchains: ["rust-analyzer"],
  collect: (input, context) => {
    const rustAnalyzer = context.toolchains.get("rust-analyzer");
    const cargo = context.toolchains.get("cargo");
    // Configured env takes precedence (tools.rust-analyzer.env in toolchains.yml);
    // the fallback injects the cargo executable directory into PATH so
    // rust-analyzer can locate cargo for proc-macro/build-script workspace
    // loading, mirroring the Rust symbol-use provider.
    const configuredEnv = rustAnalyzer?.env ?? cargo?.env;
    const environment = cargo?.executable
      ? { ...process.env, ...configuredEnv, PATH: [dirname(cargo.executable), process.env.PATH].filter(Boolean).join(delimiter) }
      : configuredEnv
        ? { ...process.env, ...configuredEnv }
        : undefined;
    return collectRustSemanticRelations(input, {
      parser: context.parser,
      executable: rustAnalyzer?.executable,
      ...(environment ? { environment } : {}),
    });
  },
};
