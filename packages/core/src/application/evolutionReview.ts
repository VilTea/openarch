import { Effect } from "effect";
import { analyzeEvolutionSignals, type EvolutionChangeSet, type EvolutionSignalReport } from "../domain/evolutionSignals";
import { COCHANGE_EVIDENCE_COMMIT_BUDGET, enrichCochangeSets, enrichCoordinationCandidates, pruneUncorroboratedCochangeSets, type CochangeSetEnrichmentTrace, type EvolutionEnrichmentTrace } from "./evolutionEvidence";
import { ParserService } from "../port/ParserService";
import { StorageService } from "../port/StorageService";

export interface EvolutionReviewReport extends EvolutionSignalReport {
  readonly enrichment: EvolutionEnrichmentTrace;
  readonly cochangeEnrichment: CochangeSetEnrichmentTrace;
  readonly extensionSurfaceEnrichment: CochangeSetEnrichmentTrace;
}

const emptyCochangeEnrichment = (commitBudget: number): { readonly candidatesSelected: number; readonly commitsSelected: number; readonly alignedCommits: number; readonly unavailableCommits: number; readonly commitBudget: number } => ({
  candidatesSelected: 0,
  commitsSelected: 0,
  alignedCommits: 0,
  unavailableCommits: 0,
  commitBudget,
});

/**
 * Reuses Git commit groups and baseline facts to surface repeated co-change for
 * investigation. It deliberately does not alter CRL, I_push, gate or history.
 */
export const evolutionReview = (cwd: string, changeSets: readonly EvolutionChangeSet[]) =>
  Effect.gen(function* () {
    const storage = yield* StorageService;
    const parser = yield* ParserService;
    const metrics = yield* storage.listAllFileMetrics();
    const rawSignals = analyzeEvolutionSignals(
      changeSets,
      metrics.map(([path, entry]) => ({
        path: path.replace(/\\/g, "/"),
        fileKind: entry.fileKind,
        loc: entry.loc,
        inDegree: entry.inDegree,
        alphaStruct: entry.alphaStruct,
        imports: entry.imports,
        reexports: entry.reexports,
      })),
    ) satisfies EvolutionSignalReport;
    // Older baselines contain only a flat import list. Treating it as implementation evidence
    // would reintroduce public-barrel noise, so ask for a scan instead of guessing.
    const relationFactsMissing = metrics.some(([, entry]) => entry.reexports === undefined);
    const signals: EvolutionSignalReport = relationFactsMissing
      ? {
        ...rawSignals,
        coordinationCandidates: [],
        extensionSurfaces: { availability: "unavailable", candidates: [], reason: "baseline 缺少模块关系分类；运行 openarch scan 后再进行演化分析。" },
        cochangeSets: { availability: "unavailable", candidates: [], reason: "baseline 缺少模块关系分类；运行 openarch scan 后再进行演化分析。" },
        relationFacts: { availability: "unavailable", reason: "baseline 仅保存未分类 import；运行 openarch scan 生成 re-export 事实。" },
      }
      : rawSignals;
    const enrichment = yield* Effect.promise(() => enrichCoordinationCandidates(cwd, signals.coordinationCandidates, parser));
    const cochangeEnrichment = signals.cochangeSets.availability === "available"
      ? yield* Effect.promise(() => enrichCochangeSets(cwd, signals.cochangeSets.candidates, parser))
      : { candidates: signals.cochangeSets.candidates, trace: emptyCochangeEnrichment(COCHANGE_EVIDENCE_COMMIT_BUDGET) };
    const coordinatorEvidence = new Map(enrichment.candidates.map((candidate) => [candidate.coordinator, candidate.historicalEvidence]));
    const extensionSurfaces = {
      ...signals.extensionSurfaces,
      candidates: signals.extensionSurfaces.candidates.map((candidate) => ({
        ...candidate,
        coordinationEvidence: coordinatorEvidence.get(candidate.coordinator),
      })),
    };
    const extensionSurfaceEnrichment = extensionSurfaces.availability !== "unavailable"
      ? yield* Effect.promise(() => enrichCochangeSets(cwd, extensionSurfaces.candidates, parser, { commitBudget: 6, maxCandidates: 2 }))
      : { candidates: extensionSurfaces.candidates, trace: emptyCochangeEnrichment(6) };
    return {
      ...signals,
      coordinationCandidates: enrichment.candidates,
      cochangeSets: { ...signals.cochangeSets, candidates: pruneUncorroboratedCochangeSets(cochangeEnrichment.candidates) },
      extensionSurfaces: { ...extensionSurfaces, candidates: pruneUncorroboratedCochangeSets(extensionSurfaceEnrichment.candidates) },
      enrichment: enrichment.trace,
      cochangeEnrichment: cochangeEnrichment.trace,
      extensionSurfaceEnrichment: extensionSurfaceEnrichment.trace,
    } satisfies EvolutionReviewReport;
  });
