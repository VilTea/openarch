/**
 * Shared semantic-relation LSP resolution pipeline.
 *
 * This is the Template Method core for the four language providers. The
 * pipeline owns the fixed order:
 *
 *   start session -> initialize -> open documents -> warmup -> diagnostics
 *   -> resolve candidates -> isComplete -> build report
 *
 * Language differences are expressed through a kernel (Strategy) and optional
 * hooks; the pipeline never branches on `language`.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Language } from "../../domain/ast";
import type { LspLaunchSpec, LspSession } from "../lsp/NodeLspSession";
import { startNodeLspSession } from "../lsp/NodeLspSession";
import type { ParserService } from "../../port/ParserService";
import { listProjectSourceFiles } from "../../projectFiles";
import type { SemanticRelationFact, SemanticRelationReport, SemanticRelationSymbol } from "../../semantic-relations/types";
import {
  initializeRelationWorkspace,
  openRelationDocuments,
  relationPositionForOffset,
  relationRelativeFile,
  warmupRelationDocuments,
} from "./relationLsp";
import {
  DIAGNOSTIC_READINESS_TIMEOUT_MS,
  LSP_REQUEST_TIMEOUT_MS,
  uniqueFacts,
  unavailableFor,
} from "./semanticRelationShared";

export type DiagnosticsMode = "always" | "whenNoCandidates" | "none";

export interface PipelineRuntime {
  readonly executable?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly startSession?: (launch: LspLaunchSpec, cwd: string) => LspSession | Promise<LspSession>;
}

export interface CandidateResolutionStats {
  readonly resolved: number;
  readonly unresolved: number;
  readonly targetCount: number;
  readonly factCount: number;
  readonly failedRequests?: number;
  readonly skippedWithoutImplSource?: number;
  readonly skippedImplementsSourceKind?: number;
  readonly requestedCandidateTargets?: number;
}

export interface CandidateResolutionResult<T, D = unknown> {
  readonly targets: readonly T[];
  /** Source declaration resolved during a detailed candidate resolution. */
  readonly sourceDeclaration?: D;
  readonly failedRequests?: number;
  readonly skippedWithoutImplSource?: number;
  readonly skippedImplementsSourceKind?: number;
  readonly requestedCandidateTargets?: number;
}

export interface LspResolutionKernel<D, C, T> {
  readonly id: string;
  readonly displayName?: string;
  readonly language: Language;
  readonly providerId: string;
  readonly languageId: string;
  readonly diagnosticsMode: DiagnosticsMode;
  readonly warmup?: boolean;
  readonly shouldWarmup?: (runtime: PipelineRuntime) => boolean;
  readonly concurrency?: number;
  readonly launch: (executable: string, runtime: PipelineRuntime) => LspLaunchSpec;
  readonly collectDeclarations: (parser: ParserService, files: readonly string[]) => Promise<readonly D[]>;
  readonly collectCandidates: (
    parser: ParserService,
    files: readonly string[],
    declarations: readonly D[],
    sources: ReadonlyMap<string, string>,
  ) => Promise<readonly C[]>;
  readonly resolveCandidate: (session: LspSession, candidate: C, ctx: { readonly cwd: string; readonly sources: ReadonlyMap<string, string>; readonly declarations: readonly D[] }) => Promise<readonly T[]>;
  readonly resolveCandidateDetailed?: (session: LspSession, candidate: C, ctx: { readonly cwd: string; readonly sources: ReadonlyMap<string, string>; readonly declarations: readonly D[] }) => Promise<CandidateResolutionResult<T, D>>;
  readonly shouldResolve?: (candidate: C) => boolean;
  readonly sourceFileOf: (candidate: C) => string;
  readonly sourceDeclarationOf: (candidate: C) => D;
  readonly offsetOf: (candidate: C) => number;
  readonly lineOf: (candidate: C) => number;
  readonly targetFileOf: (target: T) => string;
  readonly sourceSymbol: (source: D, file: string) => SemanticRelationSymbol;
  readonly targetSymbol: (target: T, file: string) => SemanticRelationSymbol;
  readonly factOf: (candidate: C, source: SemanticRelationSymbol, target: SemanticRelationSymbol, file: string, line: number) => SemanticRelationFact;
  readonly readinessProbe?: (session: LspSession, ctx: { readonly cwd: string; readonly files: readonly string[]; readonly declarations: readonly D[]; readonly candidates: readonly C[]; readonly warmupIncomplete: boolean }) => Promise<boolean>;
  readonly workspaceRisks: (cwd: string, files: readonly string[], sources: ReadonlyMap<string, string>) => readonly string[];
  readonly collectWorkspaceRisks?: (parser: ParserService, cwd: string, files: readonly string[], declarations: readonly D[], candidates: readonly C[], sources: ReadonlyMap<string, string>) => readonly string[] | Promise<readonly string[]>;
  readonly isComplete: (stats: CandidateResolutionStats, diagnosticsReady: boolean, risks: readonly string[], warmupIncomplete: boolean, candidates: readonly C[], readinessReady: boolean) => boolean;
  readonly partialReasons: (
    stats: CandidateResolutionStats,
    diagnosticsReady: boolean,
    risks: readonly string[],
    warmupIncomplete: boolean,
    candidates: readonly C[],
    readinessReady: boolean,
  ) => readonly string[];
}

export interface LspResolutionInput<D, C, T> {
  readonly cwd: string;
  readonly parser: ParserService;
  readonly runtime: PipelineRuntime;
  readonly kernel: LspResolutionKernel<D, C, T>;
}

const readSources = (files: readonly string[]): Map<string, string> => {
  const sources = new Map<string, string>();
  for (const file of files) sources.set(file, readFileSync(file, "utf8"));
  return sources;
};

export const runLspResolutionPipeline = async <D, C, T>(input: LspResolutionInput<D, C, T>): Promise<SemanticRelationReport> => {
  const { cwd, parser, runtime, kernel } = input;
  const executable = runtime.executable;
  if (!executable) return unavailableFor({ language: kernel.language, providerId: kernel.providerId, evidenceSource: "lsp" }, `${kernel.displayName ?? kernel.id} executable is unavailable; configure the ${kernel.language} toolchain`);

  const files = listProjectSourceFiles({ cwd, languages: [kernel.language], population: "production-governance" });
  if (files.length === 0) return unavailableFor({ language: kernel.language, providerId: kernel.providerId, evidenceSource: "lsp" }, `no governed ${kernel.language} source files`);

  const declarations = await kernel.collectDeclarations(parser, files);
  const sources = readSources(files);
  const candidates = await kernel.collectCandidates(parser, files, declarations, sources);

  let session: LspSession;
  try {
    session = await (runtime.startSession ?? startNodeLspSession)(kernel.launch(executable, runtime), cwd);
  } catch (error) {
    return unavailableFor({ language: kernel.language, providerId: kernel.providerId, evidenceSource: "lsp" }, `failed to start ${kernel.displayName ?? kernel.id}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    try {
      await initializeRelationWorkspace(session, cwd, "definitionProvider");
    } catch (error) {
      return unavailableFor({ language: kernel.language, providerId: kernel.providerId, evidenceSource: "lsp" }, `failed to initialize ${kernel.displayName ?? kernel.id}: ${error instanceof Error ? error.message : String(error)}`);
    }

    openRelationDocuments(session, files, kernel.languageId);
    const shouldWarmup = kernel.shouldWarmup ? kernel.shouldWarmup(runtime) : kernel.warmup !== false;
    const warmupIncomplete = shouldWarmup
      ? await warmupRelationDocuments(session, files, LSP_REQUEST_TIMEOUT_MS)
      : false;

    const uris = files.map((file) => pathToFileURL(file).href);
    let diagnosticsReady = true;
    if (kernel.diagnosticsMode === "always" && session.waitForDiagnostics) {
      diagnosticsReady = await session.waitForDiagnostics(uris, DIAGNOSTIC_READINESS_TIMEOUT_MS).catch(() => false);
    } else if (kernel.diagnosticsMode === "whenNoCandidates" && candidates.length === 0 && session.waitForDiagnostics) {
      diagnosticsReady = await session.waitForDiagnostics(uris, DIAGNOSTIC_READINESS_TIMEOUT_MS).catch(() => false);
    }

    const readinessReady = kernel.readinessProbe
      ? await kernel.readinessProbe(session, { cwd, files, declarations, candidates, warmupIncomplete })
      : true;

    let resolved = 0;
    let unresolved = 0;
    let targetCount = 0;
    let failedRequests = 0;
    let skippedWithoutImplSource = 0;
    let skippedImplementsSourceKind = 0;
    let requestedCandidateTargets = 0;
    const facts: SemanticRelationFact[] = [];
    const resolveOne = async (candidate: C): Promise<void> => {
      if (kernel.shouldResolve && !kernel.shouldResolve(candidate)) return;
      const sourceFile = kernel.sourceFileOf(candidate);
      const position = relationPositionForOffset(sources.get(sourceFile)!, kernel.offsetOf(candidate));
      try {
        const detailed = kernel.resolveCandidateDetailed
          ? await kernel.resolveCandidateDetailed(session, candidate, { cwd, sources, declarations })
          : undefined;
        const targets = detailed ? detailed.targets : await kernel.resolveCandidate(session, candidate, { cwd, sources, declarations });
        resolved += 1;
        targetCount += targets.length;
        failedRequests += detailed?.failedRequests ?? 0;
        skippedWithoutImplSource += detailed?.skippedWithoutImplSource ?? 0;
        skippedImplementsSourceKind += detailed?.skippedImplementsSourceKind ?? 0;
        requestedCandidateTargets += detailed?.requestedCandidateTargets ?? 0;
        const sourceDeclaration = detailed?.sourceDeclaration ?? kernel.sourceDeclarationOf(candidate);
        const source = kernel.sourceSymbol(sourceDeclaration, relationRelativeFile(cwd, sourceFile));
        for (const target of targets) {
          facts.push(kernel.factOf(
            candidate,
            source,
            kernel.targetSymbol(target, kernel.targetFileOf(target)),
            relationRelativeFile(cwd, sourceFile),
            kernel.lineOf(candidate),
          ));
        }
      } catch {
        unresolved += 1;
      }
    };

    const concurrency = kernel.concurrency ?? 1;
    if (concurrency <= 1) {
      for (const candidate of candidates) await resolveOne(candidate);
    } else {
      let next = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          const index = next;
          next += 1;
          if (index >= candidates.length) return;
          await resolveOne(candidates[index]);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()));
    }

    const stats: CandidateResolutionStats = {
      resolved, unresolved, targetCount, factCount: facts.length,
      ...(failedRequests > 0 ? { failedRequests } : {}),
      ...(skippedWithoutImplSource > 0 ? { skippedWithoutImplSource } : {}),
      ...(skippedImplementsSourceKind > 0 ? { skippedImplementsSourceKind } : {}),
      ...(requestedCandidateTargets > 0 ? { requestedCandidateTargets } : {}),
    };
    const risks = kernel.collectWorkspaceRisks
      ? await kernel.collectWorkspaceRisks(parser, cwd, files, declarations, candidates, sources)
      : kernel.workspaceRisks(cwd, files, sources);
    const complete = kernel.isComplete(stats, diagnosticsReady, risks, warmupIncomplete, candidates, readinessReady);
    const reasons = complete ? [] : kernel.partialReasons(stats, diagnosticsReady, risks, warmupIncomplete, candidates, readinessReady);
    return {
      origin: { language: kernel.language, providerId: kernel.providerId, evidenceSource: "lsp" },
      state: {
        availability: complete ? "available" : "partial",
        coverage: {
          symbols: complete ? "complete" : "partial",
          relations: complete ? "complete" : "partial",
        },
        ...(complete ? {} : { reason: reasons.join("; ") }),
      },
      facts: uniqueFacts(facts),
    };
  } finally {
    await Promise.resolve(session.close());
  }
};
