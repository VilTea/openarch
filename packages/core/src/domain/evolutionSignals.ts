import type { FileKind } from "./testGovernance";
import type { ChangeKind } from "./weights";
import { buildCoordinationCandidates, buildExtensionSurfaceAnalysis } from "./evolutionCoordination";
import { buildCochangeSetAnalysis, collectEvolutionHistory } from "./evolutionHistory";
import { toPosixPath } from "../infra/paths";

export interface EvolutionChangeSet {
  readonly id: string;
  readonly files: readonly string[];
  /** Git change actions distinguish extension evidence from ordinary co-change. */
  readonly changes?: readonly EvolutionFileChange[];
}

export type EvolutionChangeKind = "added" | "modified" | "deleted";

export interface EvolutionFileChange {
  readonly path: string;
  readonly kind: EvolutionChangeKind;
}

/** Raw baseline facts used only to explain a co-change candidate, never to score a gate. */
export interface EvolutionFileFact {
  readonly path: string;
  readonly fileKind?: FileKind;
  readonly loc?: number;
  readonly inDegree: number;
  readonly alphaStruct: number;
  readonly imports?: readonly string[];
  /** Parser-confirmed public forwarding paths. These are not implementation-import evidence. */
  readonly reexports?: readonly string[];
}

/**
 * A closed repeated set of three or more current production files. This keeps
 * one batch's redundant pair/subset projections out of the review report.
 */
export interface CochangeSetCandidate {
  readonly files: readonly string[];
  readonly occurrences: number;
  /** Lowest per-member co-change coverage, so one frequently changed hub is visible. */
  readonly minimumMemberCoverage: number;
  /** Mean number of current production files in supporting commits; larger means more batch noise. */
  readonly averageBatchSize: number;
  /** Current static imports whose source and target both belong to this set. */
  readonly currentInternalImportCount: number;
  /** Weakly connected components in the current set-induced static import graph. */
  readonly currentImportComponents: number;
  /** Git action evidence for candidate members only; missing commit actions remain explicit. */
  readonly actionSummary: CochangeActionSummary;
  /** Bounded evidence references let review reopen the exact history batches. */
  readonly historyEntries: readonly string[];
  /** Internal input to bounded historical enrichment; not a quality conclusion. */
  readonly supportingCommits: readonly string[];
  readonly maxInDegree: number;
  readonly maxAlphaStruct: number;
  readonly historicalEvidence?: CochangeSetHistoricalEvidence;
}

export interface CochangeActionSummary {
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  /** Number of supporting commits that supplied file-level Git actions. */
  readonly observedCommits: number;
}

/** Same declaration-level change-kind set across a bounded historical sample. */
export type CochangeSetHistoricalStatus = "aligned" | "mixed" | "partial" | "unavailable";

export interface CochangeSetHistoricalEvidence {
  readonly status: CochangeSetHistoricalStatus;
  readonly inspectedCommits: number;
  readonly alignedCommits: number;
  readonly unavailableCommits: number;
  /** The most common non-whitespace declaration-level change kinds in the sample. */
  readonly dominantChangeKinds: readonly ChangeKind[];
}

export interface CochangeSetAnalysis {
  readonly availability: "available" | "unavailable";
  readonly candidates: readonly CochangeSetCandidate[];
  /** Enumeration limits are reported rather than treating partial exploration as clean. */
  readonly reason?: string;
}

/**
 * A closed co-change set calculated only from the pre-existing files modified
 * during repeated extensions through one already-qualified coordinator. It is
 * deliberately separate from the global 3-file/3-commit signal: the lower
 * bound describes repeated integration writes, not arbitrary repository-wide
 * co-change.
 */
export interface ExtensionSurfaceCandidate extends CochangeSetCandidate {
  readonly coordinator: string;
  /** Distinct new members whose extension commits support this projection. */
  readonly extensionMembers: readonly string[];
  readonly extensionCommitCount: number;
  /** Historical direct-import evidence inherited from the parent coordinator. */
  readonly coordinationEvidence?: CoordinationHistoricalEvidence;
}

export interface ExtensionSurfaceAnalysis {
  readonly availability: "available" | "partial" | "unavailable";
  readonly candidates: readonly ExtensionSurfaceCandidate[];
  /** A bounded projection can be partial without treating observed candidates as clean. */
  readonly reason?: string;
}

/**
 * A pre-existing coordinator is changed while several distinct direct members
 * are introduced in separate commits. This is stronger evidence of an
 * integration surface than an isolated pair, but cannot prove the coordinator
 * is an unnecessary registry.
 */
export interface CoordinationCandidate {
  readonly coordinator: string;
  readonly members: readonly string[];
  /** Raw extension events retained for bounded historical confirmation. */
  readonly events: readonly CoordinationEvent[];
  readonly coordinatorLoc: number;
  readonly averageMemberLoc: number;
  readonly directImportCount: number;
  /** Distinct commits that introduced a member through this coordinator. */
  readonly commitCount: number;
  readonly occurrences: number;
  readonly historyEntries: readonly string[];
  readonly maxInDegree: number;
  readonly maxAlphaStruct: number;
  readonly historicalEvidence?: CoordinationHistoricalEvidence;
}

export interface CoordinationEvent {
  readonly member: string;
  readonly commitId: string;
}

export type HistoricalEvidenceStatus = "confirmed" | "not_confirmed" | "partial" | "unavailable";

export interface CoordinationHistoricalEvidence {
  readonly status: HistoricalEvidenceStatus;
  readonly inspectedEvents: number;
  readonly confirmedEvents: number;
  readonly unavailableEvents: number;
}

export interface EvolutionSignalReport {
  readonly eligibleChangeSets: number;
  /** Pure current-production additions establish no prior co-change relation. */
  readonly bootstrapChangeSetsExcluded: number;
  /** Historical paths absent from current baseline facts are excluded, never inferred as production. */
  readonly unavailableHistoryFiles: number;
  /** Present when the baseline predates relation classification; old import strings are not treated as proof. */
  readonly relationFacts?: { readonly availability: "unavailable"; readonly reason: string };
  readonly coordinationCandidates: readonly CoordinationCandidate[];
  readonly extensionSurfaces: ExtensionSurfaceAnalysis;
  readonly cochangeSets: CochangeSetAnalysis;
}

/**
 * Finds repeated closed production-file co-change sets. This is an investigation
 * cue, not a claim that a set is corrupt or must be refactored.
 */
export const analyzeEvolutionSignals = (
  changeSets: readonly EvolutionChangeSet[],
  facts: readonly EvolutionFileFact[],
): EvolutionSignalReport => {
  const factByPath = new Map(facts.map((fact) => [toPosixPath(fact.path), fact]));
  const history = collectEvolutionHistory(changeSets, factByPath);
  const coordinationCandidates = buildCoordinationCandidates(history, factByPath);
  return {
    eligibleChangeSets: history.eligibleChangeSets,
    bootstrapChangeSetsExcluded: history.bootstrapChangeSetsExcluded,
    unavailableHistoryFiles: history.unavailableHistoryFiles,
    coordinationCandidates,
    extensionSurfaces: buildExtensionSurfaceAnalysis(history, factByPath, coordinationCandidates),
    cochangeSets: buildCochangeSetAnalysis(history, factByPath),
  };
};
