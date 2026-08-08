import { buildClosedCochangeAnalysis, normalizedImports, normalizedReexports, splitExtension, type EvolutionHistory, type ProductionChangeSet } from "./evolutionHistory";
import type { CoordinationCandidate, CoordinationEvent, EvolutionFileFact, ExtensionSurfaceAnalysis, ExtensionSurfaceCandidate } from "./evolutionSignals";

type FactByPath = ReadonlyMap<string, EvolutionFileFact>;

interface ExtensionRelation {
  readonly member: string;
  readonly historyEntries: readonly string[];
}

const coordinatorRelations = (history: EvolutionHistory): ReadonlyMap<string, readonly ExtensionRelation[]> => {
  const relations = new Map<string, ExtensionRelation[]>();
  for (const [key, historyEntries] of history.extensionOccurrences) {
    const [coordinator, member] = splitExtension(key);
    relations.set(coordinator, [...(relations.get(coordinator) ?? []), { member, historyEntries }]);
  }
  return relations;
};

const toCoordinationCandidate = (coordinator: string, relations: readonly ExtensionRelation[], facts: FactByPath): CoordinationCandidate => {
  const events = relations.flatMap<CoordinationEvent>((relation) => relation.historyEntries.map((commitId) => ({ member: relation.member, commitId })))
    .sort((left, right) => left.commitId.localeCompare(right.commitId) || left.member.localeCompare(right.member));
  const members = [...new Set(events.map((event) => event.member))].sort();
  const coordinatorFact = facts.get(coordinator);
  const memberLocs = members.map((member) => facts.get(member)?.loc).filter((loc): loc is number => loc !== undefined);
  const historyEntries = [...new Set(events.map((event) => event.commitId))];
  return {
    coordinator,
    members,
    events,
    coordinatorLoc: coordinatorFact?.loc ?? 0,
    averageMemberLoc: memberLocs.length === 0 ? 0 : memberLocs.reduce((sum, loc) => sum + loc, 0) / memberLocs.length,
    directImportCount: normalizedImports(coordinatorFact).length,
    commitCount: historyEntries.length,
    occurrences: events.length,
    historyEntries: historyEntries.slice(0, 3),
    maxInDegree: Math.max(coordinatorFact?.inDegree ?? 0, ...members.map((member) => facts.get(member)?.inDegree ?? 0)),
    maxAlphaStruct: Math.max(coordinatorFact?.alphaStruct ?? 0, ...members.map((member) => facts.get(member)?.alphaStruct ?? 0)),
  };
};

const isCompactCoordination = (candidate: CoordinationCandidate): boolean =>
  candidate.members.length >= 2 && candidate.commitCount >= 2 && candidate.coordinatorLoc > 0;

export const buildCoordinationCandidates = (history: EvolutionHistory, facts: FactByPath): readonly CoordinationCandidate[] =>
  [...coordinatorRelations(history).entries()]
    .map(([coordinator, relations]) => toCoordinationCandidate(coordinator, relations, facts))
    .filter(isCompactCoordination)
    .sort((left, right) => right.members.length - left.members.length || right.occurrences - left.occurrences || right.maxAlphaStruct - left.maxAlphaStruct || left.coordinator.localeCompare(right.coordinator));

const projectedExtensionChanges = (
  history: EvolutionHistory,
  candidate: CoordinationCandidate,
  facts: FactByPath,
): readonly ProductionChangeSet[] => {
  const extensionCommits = new Set(candidate.events.map((event) => event.commitId));
  return history.changeSets.flatMap((changeSet) => {
    if (!extensionCommits.has(changeSet.id)) return [];
    // New members vary by extension. Project them away and retain only the
    // existing files that every extension had to modify.
    // A file that only publicly forwards modules is API surface maintenance, not one
    // of the implementation surfaces repeatedly edited to integrate a member.
    const changes = changeSet.changes.filter((change) => change.kind === "modified" && !isPublicForwardingOnly(facts.get(change.path)));
    const files = [...new Set(changes.map((change) => change.path))].sort();
    return files.includes(candidate.coordinator) ? [{ id: changeSet.id, files, changes }] : [];
  });
};

const isPublicForwardingOnly = (fact: EvolutionFileFact | undefined): boolean =>
  normalizedReexports(fact).length > 0 && normalizedImports(fact).length === 0;

const extensionSurfaceCandidates = (
  history: EvolutionHistory,
  candidate: CoordinationCandidate,
  facts: FactByPath,
): ExtensionSurfaceAnalysis => {
  const projected = projectedExtensionChanges(history, candidate, facts);
  if (projected.length < 2) return { availability: "available", candidates: [] };
  const analysis = buildClosedCochangeAnalysis(projected, facts, {
    minimumSetSize: 2,
    minimumSupport: 2,
    requiredFile: candidate.coordinator,
  });
  if (analysis.availability === "unavailable") {
    return { availability: "unavailable", candidates: [], reason: analysis.reason };
  }
  const membersByCommit = new Map<string, readonly string[]>();
  for (const event of candidate.events) {
    membersByCommit.set(event.commitId, [...new Set([...(membersByCommit.get(event.commitId) ?? []), event.member])]);
  }
  return {
    availability: "available",
    candidates: analysis.candidates.flatMap<ExtensionSurfaceCandidate>((surface) => {
      const extensionMembers = [...new Set(surface.supportingCommits.flatMap((commitId) => membersByCommit.get(commitId) ?? []))].sort();
      // Two files in one repeated member revision are ordinary maintenance,
      // not a repeated extension-write surface.
      if (extensionMembers.length < 2) return [];
      return [{
        ...surface,
        coordinator: candidate.coordinator,
        extensionMembers,
        extensionCommitCount: surface.supportingCommits.length,
      }];
    }),
  };
};

/**
 * Derives small closed sets only after a coordinator has independent extension
 * evidence. This avoids weakening the repository-wide co-change threshold.
 */
export const buildExtensionSurfaceAnalysis = (
  history: EvolutionHistory,
  facts: FactByPath,
  coordinators: readonly CoordinationCandidate[],
): ExtensionSurfaceAnalysis => {
  const analyses = coordinators.map((candidate) => extensionSurfaceCandidates(history, candidate, facts));
  const unavailable = analyses.filter((analysis) => analysis.availability === "unavailable");
  const candidates = analyses.flatMap((analysis) => analysis.candidates);
  const availability = unavailable.length === 0 ? "available" : candidates.length > 0 ? "partial" : "unavailable";
  return {
    availability,
    candidates,
    ...(unavailable.length > 0 ? { reason: unavailable.map((analysis) => analysis.reason ?? "projection enumeration unavailable").join("; ") } : {}),
  };
};
