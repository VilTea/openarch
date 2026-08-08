import { Effect } from "effect";
import { resolve } from "node:path";
import { collectGitRevisionChangeSet } from "./changeSet";
import { analyzeChangeSetSemantics } from "./semanticDiff";
import type { ChangeKind } from "../domain/weights";
import type { ImportRef } from "../domain/ast";
import type { CochangeSetCandidate, CochangeSetHistoricalEvidence, CoordinationCandidate, CoordinationHistoricalEvidence, HistoricalEvidenceStatus } from "../domain/evolutionSignals";
import { ParserService, type ParserService as ParserServiceShape } from "../port/ParserService";
import { mapWithConcurrency } from "../infra/boundedConcurrency";

const MAX_HISTORICAL_EVENTS = 12;
const MAX_COCHANGE_CANDIDATES = 3;
export const COCHANGE_EVIDENCE_COMMIT_BUDGET = 9;
const MAX_COCHANGE_COMMITS_PER_CANDIDATE = 3;

export interface CochangeEnrichmentOptions {
  readonly commitBudget?: number;
  readonly maxCandidates?: number;
  readonly maxCommitsPerCandidate?: number;
}

export interface EvolutionEnrichmentTrace {
  /** Candidates that received at least one historical event sample. */
  readonly candidatesSelected: number;
  /** Candidates with no sample because no event existed or the shared budget was exhausted. */
  readonly candidatesDeferred: number;
  readonly eventsSelected: number;
  readonly confirmedEvents: number;
  readonly unavailableEvents: number;
  readonly eventBudget: number;
}

export interface CochangeSetEnrichmentTrace {
  readonly candidatesSelected: number;
  readonly commitsSelected: number;
  readonly alignedCommits: number;
  readonly unavailableCommits: number;
  readonly commitBudget: number;
}

const normalizedPath = (cwd: string, path: string): string => resolve(cwd, path).replace(/\\/g, "/");

const eventStatus = async (
  cwd: string,
  candidate: CoordinationCandidate,
  event: CoordinationCandidate["events"][number],
  parser: ParserServiceShape,
): Promise<"confirmed" | "not_confirmed" | "unavailable"> => {
  const changeSet = collectGitRevisionChangeSet(cwd, event.commitId);
  if (changeSet.availability === "unavailable") return "unavailable";
  const coordinator = changeSet.files.find((file) => file.path === candidate.coordinator && file.kind === "modified");
  if (!coordinator?.beforeText || !coordinator.afterText) return "unavailable";
  const coordinatorPath = normalizedPath(cwd, candidate.coordinator);
  const memberPath = normalizedPath(cwd, event.member);
  const parsed = await Effect.runPromise(Effect.all([
    parser.parseText(coordinatorPath, coordinator.beforeText),
    parser.parseText(coordinatorPath, coordinator.afterText),
  ]).pipe(Effect.either));
  if (parsed._tag === "Left") return "unavailable";
  const [before, after] = parsed.right;
  const implementationImport = (imports: readonly ImportRef[]) => imports.some((entry) =>
    entry.relation !== "reexport" && entry.resolvedPath?.replace(/\\/g, "/") === memberPath,
  );
  const importedBefore = implementationImport(before.imports);
  const importedAfter = implementationImport(after.imports);
  return importedAfter && !importedBefore ? "confirmed" : "not_confirmed";
};

const aggregateEvidence = (statuses: readonly ("confirmed" | "not_confirmed" | "unavailable")[], budgetExhausted: boolean): CoordinationHistoricalEvidence => {
  const confirmedEvents = statuses.filter((status) => status === "confirmed").length;
  const unavailableEvents = statuses.filter((status) => status === "unavailable").length;
  const status: HistoricalEvidenceStatus = statuses.length === 0 || unavailableEvents === statuses.length
    ? "unavailable"
    : budgetExhausted || unavailableEvents > 0
      ? "partial"
      : confirmedEvents === statuses.length
        ? "confirmed"
        : "not_confirmed";
  return { status, inspectedEvents: statuses.length, confirmedEvents, unavailableEvents };
};

/**
 * Distributes a global evidence budget round-robin. Each coordination surface
 * receives a sample before an earlier, high-event surface receives another;
 * within one surface, prefer distinct members for independent extension proof.
 */
const selectCoordinationEvents = (
  candidates: readonly CoordinationCandidate[],
  budget: number,
): ReadonlyMap<CoordinationCandidate, readonly CoordinationCandidate["events"][number][]> => {
  const selected = new Map(candidates.map((candidate) => [candidate, [] as CoordinationCandidate["events"][number][]]));
  let remaining = budget;
  while (remaining > 0) {
    let selectedThisRound = false;
    for (const candidate of candidates) {
      if (remaining === 0) break;
      const events = selected.get(candidate)!;
      const usedMembers = new Set(events.map((event) => event.member));
      const next = candidate.events.find((event) => !events.includes(event) && !usedMembers.has(event.member))
        ?? candidate.events.find((event) => !events.includes(event));
      if (!next) continue;
      events.push(next);
      remaining--;
      selectedThisRound = true;
    }
    if (!selectedThisRound) break;
  }
  return selected;
};

/** Candidate-only enrichment: historical source is read only after cheap Git/action filtering. */
/** 协调候选 enrich（应用层约定例外 2026-08-07：解析密集、无取消需求，保持 async
 *  壳 + 调用方 Effect.promise 提升；内部 runPromise 的取消不传播影响可忽略——
 *  与 changeSurfaceFactsFor/loadScriptFacts（改为 Effect 原生）形成对照）。 */
export const enrichCoordinationCandidates = async (
  cwd: string,
  candidates: readonly CoordinationCandidate[],
  parser: ParserServiceShape,
): Promise<{ readonly candidates: readonly CoordinationCandidate[]; readonly trace: EvolutionEnrichmentTrace }> => {
  const selectedByCandidate = selectCoordinationEvents(candidates, MAX_HISTORICAL_EVENTS);
  const enrichedWithEvidence = await mapWithConcurrency(candidates, async (candidate) => {
    const selectedEvents = selectedByCandidate.get(candidate) ?? [];
    const statuses = await mapWithConcurrency(selectedEvents, (event) => eventStatus(cwd, candidate, event, parser));
    const historicalEvidence = aggregateEvidence(statuses, selectedEvents.length < candidate.events.length);
    return { candidate: { ...candidate, historicalEvidence }, selected: selectedEvents.length };
  });
  const eventsSelected = enrichedWithEvidence.reduce((total, entry) => total + entry.candidate.historicalEvidence!.inspectedEvents, 0);
  const confirmedEvents = enrichedWithEvidence.reduce((total, entry) => total + entry.candidate.historicalEvidence!.confirmedEvents, 0);
  const unavailableEvents = enrichedWithEvidence.reduce((total, entry) => total + entry.candidate.historicalEvidence!.unavailableEvents, 0);
  const candidatesSelected = enrichedWithEvidence.filter((entry) => entry.selected > 0).length;
  return {
    candidates: enrichedWithEvidence.map((entry) => entry.candidate),
    trace: {
      candidatesSelected,
      candidatesDeferred: candidates.length - candidatesSelected,
      eventsSelected,
      confirmedEvents,
      unavailableEvents,
      eventBudget: MAX_HISTORICAL_EVENTS,
    },
  };
};

interface CochangeCommitEvidence {
  readonly availability: "available" | "unavailable";
  readonly changeKinds: readonly ChangeKind[];
}

const cochangeCommitEvidence = async (
  cwd: string,
  candidate: CochangeSetCandidate,
  commitId: string,
  parser: ParserServiceShape,
): Promise<CochangeCommitEvidence> => {
  const changeSet = collectGitRevisionChangeSet(cwd, commitId);
  if (changeSet.availability !== "available") return { availability: "unavailable", changeKinds: [] };
  const result = await Effect.runPromise(
    analyzeChangeSetSemantics(cwd, changeSet, { paths: candidate.files }).pipe(
      Effect.provideService(ParserService, parser),
      Effect.either,
    ),
  );
  if (result._tag === "Left" || result.right.availability !== "available") return { availability: "unavailable", changeKinds: [] };
  return {
    availability: "available",
    changeKinds: [...new Set(result.right.profiles.flatMap((profile) => profile.changes.map((change) => change.kind)).filter((kind) => kind !== "comment_whitespace"))].sort(),
  };
};

const cochangeEvidence = (events: readonly CochangeCommitEvidence[], budgetExhausted: boolean): CochangeSetHistoricalEvidence => {
  const unavailableCommits = events.filter((event) => event.availability === "unavailable").length;
  const fingerprints = new Map<string, { readonly kinds: readonly ChangeKind[]; count: number }>();
  for (const event of events) {
    if (event.availability !== "available" || event.changeKinds.length === 0) continue;
    const key = event.changeKinds.join("\0");
    const existing = fingerprints.get(key);
    fingerprints.set(key, { kinds: event.changeKinds, count: (existing?.count ?? 0) + 1 });
  }
  const dominant = [...fingerprints.values()].sort((left, right) => right.count - left.count || left.kinds.join("\0").localeCompare(right.kinds.join("\0")))[0];
  const alignedCommits = dominant?.count ?? 0;
  const status = events.length === 0 || unavailableCommits === events.length
    ? "unavailable"
    : budgetExhausted || unavailableCommits > 0
      ? "partial"
      : alignedCommits === events.length && dominant !== undefined
        ? "aligned"
        : "mixed";
  return {
    status,
    inspectedCommits: events.length,
    alignedCommits,
    unavailableCommits,
    dominantChangeKinds: dominant?.kinds ?? [],
  };
};

/** Candidate-only semantic enrichment for closed co-change sets. */
export const enrichCochangeSets = async <Candidate extends CochangeSetCandidate>(
  cwd: string,
  candidates: readonly Candidate[],
  parser: ParserServiceShape,
  options: CochangeEnrichmentOptions = {},
): Promise<{ readonly candidates: readonly Candidate[]; readonly trace: CochangeSetEnrichmentTrace }> => {
  const commitBudget = options.commitBudget ?? COCHANGE_EVIDENCE_COMMIT_BUDGET;
  const maxCandidates = options.maxCandidates ?? MAX_COCHANGE_CANDIDATES;
  const maxCommitsPerCandidate = options.maxCommitsPerCandidate ?? MAX_COCHANGE_COMMITS_PER_CANDIDATE;
  let remaining = commitBudget;
  let commitsSelected = 0;
  let alignedCommits = 0;
  let unavailableCommits = 0;
  const selected = new Set(candidates.slice(0, maxCandidates));
  const enriched: Candidate[] = [];
  for (const candidate of candidates) {
    if (!selected.has(candidate)) {
      enriched.push(candidate);
      continue;
    }
    const commits = candidate.supportingCommits.slice(0, Math.min(maxCommitsPerCandidate, Math.max(0, remaining)));
    remaining -= commits.length;
    const events = await mapWithConcurrency(commits, (commit) => cochangeCommitEvidence(cwd, candidate, commit, parser));
    const historicalEvidence = cochangeEvidence(events, commits.length < candidate.supportingCommits.length);
    commitsSelected += historicalEvidence.inspectedCommits;
    alignedCommits += historicalEvidence.alignedCommits;
    unavailableCommits += historicalEvidence.unavailableCommits;
    enriched.push({ ...candidate, historicalEvidence });
  }
  return {
    candidates: enriched,
    trace: {
      candidatesSelected: selected.size,
      commitsSelected,
      alignedCommits,
      unavailableCommits,
      commitBudget,
    },
  };
};

/**
 * A set with no current internal static relation and confirmed mixed historical
 * declaration changes has no remaining structural evidence for review. Partial
 * and unavailable history stay visible rather than being treated as noise.
 */
export const pruneUncorroboratedCochangeSets = <Candidate extends CochangeSetCandidate>(candidates: readonly Candidate[]): readonly Candidate[] =>
  candidates.filter((candidate) =>
    candidate.currentImportComponents < candidate.files.length || candidate.historicalEvidence?.status !== "mixed",
  );
