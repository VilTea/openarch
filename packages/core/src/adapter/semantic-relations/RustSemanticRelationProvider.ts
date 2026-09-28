// packages/core/src/adapter/semantic-relations/RustSemanticRelationProvider.ts
//
// Rust 语义关系 provider：LSP 会话/进程生命周期、kernel 契约与报告装配。
// Rust 语言映射（query、锚点、候选、工作区风险）在 `RustSemanticSyntax.ts`，
// 那一层不持有会话，可被独立特征化。
import { delimiter, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import type { LspSession } from "../lsp/NodeLspSession";
import {
  relationDefinitionLocations,
  relationLaunch,
  relationPositionForOffset,
  relationRelativeFile,
  relationRepositoryPath,
} from "./relationLsp";
import {
  runLspResolutionPipeline,
  type CandidateResolutionResult,
  type LspResolutionKernel,
  type PipelineRuntime,
} from "./semanticRelationPipeline";
import { DIAGNOSTIC_READINESS_TIMEOUT_MS, LSP_REQUEST_TIMEOUT_MS, unavailableFor } from "./semanticRelationShared";
import {
  TARGET_KINDS,
  canonicalWorkspaceUri,
  collectRustCandidates,
  collectRustDeclarations,
  collectRustSyntaxWorkspaceRisks,
  collectRustWorkspaceRisks,
  declarationFor,
  declarationSymbol,
  implementsSourceKinds,
  typeAnchorFor,
  SOURCE_KINDS,
  type RelationCandidate,
  type RustDeclaration,
  type RustImpl,
  type RustTarget,
  type TypeAnchor,
} from "./RustSemanticSyntax";
import type { ParserService } from "../../port/ParserService";
import type { SemanticRelationProvider, SemanticRelationRequest } from "../../semantic-relations/provider";
import type { SemanticRelationFact, SemanticRelationReport, SemanticRelationSymbol } from "../../semantic-relations/types";

interface RustResolutionStats {
  failedRequests: number;
  requestedCandidateTargets: number;
  skippedWithoutImplSource: number;
  skippedImplementsSourceKind: number;
}

export interface RustSemanticRelationRuntime extends PipelineRuntime {
  readonly parser?: ParserService;
}

const unavailable = (reason: string): SemanticRelationReport =>
  unavailableFor({ language: "rust", providerId: "rust-rust-analyzer-semantic-relations", evidenceSource: "lsp" }, reason);

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
  ctx: { readonly cwd: string; readonly sources: ReadonlyMap<string, string>; readonly declarations: readonly RustDeclaration[] },
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
  ctx: { readonly cwd: string; readonly sources: ReadonlyMap<string, string>; readonly declarations: readonly RustDeclaration[] },
  stats: RustResolutionStats,
  impl: RustImpl,
): Promise<RustDeclaration | undefined> => {
  if (impl.resolvedSource !== undefined) return impl.resolvedSource ?? undefined;
  const anchor = typeAnchorFor(ctx.sources.get(impl.file)!, impl.typeRef);
  if (!anchor) {
    impl.resolvedSource = null;
    return undefined;
  }
  const targets = await resolveRustDefinition(session, ctx, stats, impl.file, anchor);
  const declaration = targets.find((target) => SOURCE_KINDS.includes(target.kind));
  impl.resolvedSource = declaration ?? null;
  return declaration;
};

const resolveRustCandidateDetailed = async (
  session: LspSession,
  candidate: RelationCandidate,
  ctx: { readonly cwd: string; readonly sources: ReadonlyMap<string, string>; readonly declarations: readonly RustDeclaration[] },
): Promise<CandidateResolutionResult<RustTarget, RustDeclaration>> => {
  const stats: RustResolutionStats = { failedRequests: 0, requestedCandidateTargets: 0, skippedWithoutImplSource: 0, skippedImplementsSourceKind: 0 };
  const sourceDecl = candidate.source ?? (candidate.sourceImpl ? await resolveRustImplSource(session, ctx, stats, candidate.sourceImpl) : undefined);
  if (!sourceDecl) {
    return {
      targets: [],
      skippedWithoutImplSource: 1,
      ...(stats.failedRequests > 0 ? { failedRequests: stats.failedRequests } : {}),
    };
  }
  if (candidate.kind === "implements" && !implementsSourceKinds.includes(sourceDecl.kind)) {
    return {
      targets: [],
      skippedImplementsSourceKind: 1,
      ...(stats.failedRequests > 0 ? { failedRequests: stats.failedRequests } : {}),
    };
  }
  stats.requestedCandidateTargets += 1;
  const targets = await resolveRustDefinition(session, ctx, stats, candidate.file, candidate.target);
  const filtered = targets.filter((target) => TARGET_KINDS[candidate.kind].includes(target.kind));
  return {
    targets: filtered.map((declaration) => ({ declaration, file: relationRelativeFile(ctx.cwd, declaration.file) })),
    sourceDeclaration: sourceDecl,
    ...(stats.failedRequests > 0 ? { failedRequests: stats.failedRequests } : {}),
    ...(stats.skippedWithoutImplSource > 0 ? { skippedWithoutImplSource: stats.skippedWithoutImplSource } : {}),
    ...(stats.skippedImplementsSourceKind > 0 ? { skippedImplementsSourceKind: stats.skippedImplementsSourceKind } : {}),
    ...(stats.requestedCandidateTargets > 0 ? { requestedCandidateTargets: stats.requestedCandidateTargets } : {}),
  };
};

const rustKernel: LspResolutionKernel<RustDeclaration, RelationCandidate, RustTarget> = {
  id: "rust-rust-analyzer-semantic-relations",
  displayName: "rust-analyzer",
  language: "rust",
  providerId: "rust-rust-analyzer-semantic-relations",
  languageId: "rust",
  diagnosticsMode: "whenNoCandidates",
  launch: (executable, runtime) => ({
    ...relationLaunch(executable),
    ...(runtime.environment ? { environment: runtime.environment } : {}),
  }),
  collectDeclarations: collectRustDeclarations,
  collectCandidates: collectRustCandidates,
  resolveCandidate: async (session, candidate, ctx) => (await resolveRustCandidateDetailed(session, candidate, ctx)).targets,
  resolveCandidateDetailed: resolveRustCandidateDetailed,
  sourceFileOf: (candidate) => candidate.file,
  sourceDeclarationOf: (candidate) => candidate.source ?? (undefined as unknown as RustDeclaration),
  offsetOf: (candidate) => candidate.target.startIndex,
  lineOf: (candidate) => candidate.line,
  targetFileOf: (target) => target.file,
  sourceSymbol: (source, file) => declarationSymbol(source, file),
  targetSymbol: (target, _file) => declarationSymbol(target.declaration, target.file),
  factOf: (candidate, source, target, file, line): SemanticRelationFact => ({
    language: "rust",
    kind: candidate.kind,
    source,
    target,
    direct: true,
    evidence: { file, line },
  }),
  readinessProbe: (session, ctx) => waitForRustDefinitionIndex(session, ctx.declarations, ctx.candidates, ctx.warmupIncomplete),
  workspaceRisks: (cwd, files) => collectRustWorkspaceRisks(cwd, files),
  collectWorkspaceRisks: (parser, cwd, files, _declarations, _candidates) =>
    collectRustSyntaxWorkspaceRisks(parser, cwd, files),
  isComplete: (stats, diagnosticsReady, risks, warmupIncomplete, candidates, readinessReady) => {
    const requestComplete = candidates.length === 0
      ? diagnosticsReady
      : (stats.failedRequests ?? 0) === 0 && (stats.requestedCandidateTargets ?? 0) === candidates.length && stats.factCount > 0;
    return requestComplete && readinessReady && !warmupIncomplete && risks.length === 0;
  },
  partialReasons: (stats, diagnosticsReady, risks, warmupIncomplete, candidates, readinessReady) => [
    ...(candidates.length === 0 && !diagnosticsReady ? ["rust-analyzer diagnostics readiness did not complete"] : []),
    ...(candidates.length > 0 && !readinessReady ? ["rust-analyzer definition index readiness did not complete"] : []),
    ...(warmupIncomplete ? ["some documentSymbol warmup requests failed"] : []),
    ...risks,
    ...((stats.failedRequests ?? 0) > 0 ? [`${stats.failedRequests} definition request(s) failed`] : []),
    ...((stats.skippedWithoutImplSource ?? 0) > 0 ? [`${stats.skippedWithoutImplSource} candidate(s) skipped because their impl source did not resolve to a repository struct/enum/trait`] : []),
    ...((stats.skippedImplementsSourceKind ?? 0) > 0 ? [`${stats.skippedImplementsSourceKind} implements candidate(s) skipped because the impl source is not a repository struct/enum`] : []),
    ...(candidates.length > 0 && stats.factCount === 0 ? ["no candidate definition resolved to a repository target"] : []),
  ],
};

export const collectRustSemanticRelations = (
  input: SemanticRelationRequest,
  runtime: RustSemanticRelationRuntime,
): Effect.Effect<SemanticRelationReport, never> =>
  Effect.gen(function* () {
    const parser = runtime.parser;
    if (!parser) return unavailable("ParserService is unavailable");
    return yield* Effect.promise(() => runLspResolutionPipeline({
      cwd: input.cwd,
      parser,
      runtime,
      kernel: rustKernel,
    }));
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
