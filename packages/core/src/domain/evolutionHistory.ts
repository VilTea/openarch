import type { CochangeActionSummary, CochangeSetAnalysis, CochangeSetCandidate, EvolutionChangeSet, EvolutionFileChange, EvolutionFileFact } from "./evolutionSignals";
import { participatesInPopulation } from "./fileParticipation";
import { toPosixPath } from "../infra/paths";

type FactByPath = ReadonlyMap<string, EvolutionFileFact>;

export interface ProductionChangeSet {
  readonly id: string;
  readonly files: readonly string[];
  readonly changes: readonly EvolutionFileChange[];
}

export interface EvolutionHistory {
  readonly changeSets: readonly ProductionChangeSet[];
  /** Directed coordinator -> newly added direct member relations. */
  readonly extensionOccurrences: ReadonlyMap<string, readonly string[]>;
  readonly eligibleChangeSets: number;
  /** Commits whose known current production files were all newly added. */
  readonly bootstrapChangeSetsExcluded: number;
  /** Historical paths without a current baseline fact are excluded, never assumed production. */
  readonly unavailableHistoryFiles: number;
}

const MAX_INTERSECTION_SETS = 10_000;
const MAX_INTERSECTION_OPERATIONS = 200_000;
const MIN_SET_SIZE = 3;
const MIN_SUPPORT = 3;

export interface ClosedCochangeOptions {
  readonly minimumSetSize: number;
  readonly minimumSupport: number;
  /** A constrained projection may only report sets containing its coordinator. */
  readonly requiredFile?: string;
}

const setKey = (files: Iterable<string>): string => [...files].sort().join("\0");
export const extensionKey = (coordinator: string, member: string): string => `${coordinator}\0${member}`;
export const splitExtension = (key: string): readonly [string, string] => key.split("\0") as [string, string];
export const normalizedReexports = (fact: EvolutionFileFact | undefined): readonly string[] => fact?.reexports?.map((path) => toPosixPath(path)) ?? [];

/** Public forwarding is a real module relation but not evidence that an implementation coordinator owns a new member. */
export const normalizedImports = (fact: EvolutionFileFact | undefined): readonly string[] => {
  const reexports = new Set(normalizedReexports(fact));
  return fact?.imports?.map((path) => toPosixPath(path)).filter((path) => !reexports.has(path)) ?? [];
};

const productionFiles = (changeSet: EvolutionChangeSet, facts: FactByPath, unavailable: Set<string>): readonly string[] =>
  [...new Set(changeSet.files.map((file) => toPosixPath(file)))]
    .filter((file) => {
      const fact = facts.get(file);
      if (!fact) {
        unavailable.add(file);
        return false;
      }
      return participatesInPopulation(fact.fileKind, "production-governance");
    })
    .sort();

const recordExtensions = (
  changeSet: EvolutionChangeSet,
  production: ReadonlySet<string>,
  facts: FactByPath,
  occurrences: Map<string, string[]>,
): void => {
  if (!changeSet.changes) return;
  const changes = changeSet.changes
    .map((change) => ({ ...change, path: toPosixPath(change.path) }))
    .filter((change) => production.has(change.path));
  const addedMembers = changes.filter((change) => change.kind === "added").map((change) => change.path);
  const changedCoordinators = changes.filter((change) => change.kind === "modified").map((change) => change.path);
  for (const coordinator of changedCoordinators) {
    for (const member of addedMembers) {
      if (normalizedImports(facts.get(coordinator)).includes(member)) {
        const key = extensionKey(coordinator, member);
        occurrences.set(key, [...(occurrences.get(key) ?? []), changeSet.id]);
      }
    }
  }
};

export const collectEvolutionHistory = (changeSets: readonly EvolutionChangeSet[], facts: FactByPath): EvolutionHistory => {
  const extensionOccurrences = new Map<string, string[]>();
  const productionChangeSets: ProductionChangeSet[] = [];
  const unavailable = new Set<string>();
  let bootstrapChangeSetsExcluded = 0;
  for (const changeSet of changeSets) {
    const files = productionFiles(changeSet, facts, unavailable);
    if (files.length < 2) continue;
    const production = new Set(files);
    const changes = (changeSet.changes ?? [])
      .map((change) => ({ ...change, path: toPosixPath(change.path) }))
      .filter((change) => production.has(change.path));
    // A set of newly created files has no prior relation to demonstrate. Keep
    // action-less inputs (for example imported history) explicit rather than
    // guessing that they are bootstrap commits.
    if (changes.length > 0 && changes.every((change) => change.kind === "added")) {
      bootstrapChangeSetsExcluded++;
      continue;
    }
    productionChangeSets.push({ id: changeSet.id, files, changes });
    recordExtensions(changeSet, production, facts, extensionOccurrences);
  }
  return {
    changeSets: productionChangeSets,
    extensionOccurrences,
    eligibleChangeSets: productionChangeSets.length,
    bootstrapChangeSetsExcluded,
    unavailableHistoryFiles: unavailable.size,
  };
};

const containsAll = (container: readonly string[], subset: readonly string[]): boolean => subset.every((file) => container.includes(file));

const intersect = (left: readonly string[], right: readonly string[]): readonly string[] => left.filter((file) => right.includes(file));

const importComponents = (files: readonly string[], facts: FactByPath): number => {
  const adjacent = new Map(files.map((file) => [file, new Set<string>()]));
  const fileSet = new Set(files);
  for (const file of files) {
    for (const target of normalizedImports(facts.get(file))) {
      if (!fileSet.has(target)) continue;
      adjacent.get(file)?.add(target);
      adjacent.get(target)?.add(file);
    }
  }
  const visited = new Set<string>();
  let components = 0;
  for (const file of files) {
    if (visited.has(file)) continue;
    components++;
    const pending = [file];
    visited.add(file);
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const next of adjacent.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        pending.push(next);
      }
    }
  }
  return components;
};

const actionSummary = (support: readonly ProductionChangeSet[], files: ReadonlySet<string>): CochangeActionSummary => {
  let added = 0;
  let modified = 0;
  let deleted = 0;
  let observedCommits = 0;
  for (const changeSet of support) {
    const changes = changeSet.changes.filter((change) => files.has(change.path));
    if (changes.length > 0) observedCommits++;
    for (const change of changes) {
      if (change.kind === "added") added++;
      else if (change.kind === "modified") modified++;
      else deleted++;
    }
  }
  return { added, modified, deleted, observedCommits };
};

/**
 * Keeps only non-dominated evidence: a candidate is redundant when another
 * candidate is at least as recurrent, compact, connected and observable, and
 * strictly better on one of those facts. No repository-specific threshold is
 * needed to suppress obvious batch-noise projections.
 */
const paretoFront = (candidates: readonly CochangeSetCandidate[]): readonly CochangeSetCandidate[] => {
  const compactness = (candidate: CochangeSetCandidate): number => candidate.files.length / candidate.averageBatchSize;
  const connectivity = (candidate: CochangeSetCandidate): number => candidate.files.length <= 1
    ? 0
    : (candidate.files.length - candidate.currentImportComponents) / (candidate.files.length - 1);
  const edgeDensity = (candidate: CochangeSetCandidate): number => candidate.currentInternalImportCount / candidate.files.length;
  const actionObservation = (candidate: CochangeSetCandidate): number => candidate.actionSummary.observedCommits / candidate.occurrences;
  const dominates = (left: CochangeSetCandidate, right: CochangeSetCandidate): boolean => {
    const leftValues = [left.minimumMemberCoverage, compactness(left), connectivity(left), edgeDensity(left), actionObservation(left)];
    const rightValues = [right.minimumMemberCoverage, compactness(right), connectivity(right), edgeDensity(right), actionObservation(right)];
    return leftValues.every((value, index) => value >= rightValues[index])
      && leftValues.some((value, index) => value > rightValues[index]);
  };
  return candidates.filter((candidate) => !candidates.some((other) => other !== candidate && dominates(other, candidate)));
};

export const buildClosedCochangeAnalysis = (
  changeSets: readonly ProductionChangeSet[],
  facts: FactByPath,
  options: ClosedCochangeOptions,
): CochangeSetAnalysis => {
  const itemsets = new Map<string, readonly string[]>();
  const queue: Array<readonly string[]> = [];
  for (const changeSet of changeSets) {
    const key = setKey(changeSet.files);
    if (!itemsets.has(key)) {
      itemsets.set(key, changeSet.files);
      queue.push(changeSet.files);
    }
  }

  let operations = 0;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const itemset = queue[cursor];
    for (const changeSet of changeSets) {
      operations++;
      if (operations > MAX_INTERSECTION_OPERATIONS || itemsets.size >= MAX_INTERSECTION_SETS) {
        return {
          availability: "unavailable",
          candidates: [],
          reason: `closed co-change enumeration exceeded its bounded budget (${MAX_INTERSECTION_SETS} sets / ${MAX_INTERSECTION_OPERATIONS} intersections)`,
        };
      }
      const next = intersect(itemset, changeSet.files);
      if (next.length < options.minimumSetSize) continue;
      const key = setKey(next);
      if (!itemsets.has(key)) {
        itemsets.set(key, next);
        queue.push(next);
      }
    }
  }

  const fileOccurrences = new Map<string, number>();
  for (const changeSet of changeSets) {
    for (const file of changeSet.files) fileOccurrences.set(file, (fileOccurrences.get(file) ?? 0) + 1);
  }
  const candidates: CochangeSetCandidate[] = [];
  for (const [key, files] of itemsets) {
    if (files.length < options.minimumSetSize || (options.requiredFile && !files.includes(options.requiredFile))) continue;
    const support = changeSets.filter((changeSet) => containsAll(changeSet.files, files));
    if (support.length < options.minimumSupport) continue;
    const closure = support.slice(1).reduce<readonly string[]>((shared, changeSet) => intersect(shared, changeSet.files), support[0].files);
    if (setKey(closure) !== key) continue;
    const memberCoverage = Math.min(...files.map((file) => support.length / (fileOccurrences.get(file) ?? 1)));
    const related = files.map((file) => facts.get(file));
    const fileSet = new Set(files);
    const internalImportCount = related.reduce((total, fact) => total + normalizedImports(fact).filter((target) => fileSet.has(target)).length, 0);
    candidates.push({
      files,
      occurrences: support.length,
      minimumMemberCoverage: memberCoverage,
      averageBatchSize: support.reduce((total, changeSet) => total + changeSet.files.length, 0) / support.length,
      currentInternalImportCount: internalImportCount,
      currentImportComponents: importComponents(files, facts),
      actionSummary: actionSummary(support, fileSet),
      historyEntries: support.slice(0, 3).map((changeSet) => changeSet.id),
      supportingCommits: support.map((changeSet) => changeSet.id),
      maxInDegree: Math.max(...related.map((fact) => fact?.inDegree ?? 0)),
      maxAlphaStruct: Math.max(...related.map((fact) => fact?.alphaStruct ?? 0)),
    });
  }
  return {
    availability: "available",
    candidates: [...paretoFront(candidates)].sort((left, right) =>
      right.minimumMemberCoverage - left.minimumMemberCoverage
      || (right.files.length / right.averageBatchSize) - (left.files.length / left.averageBatchSize)
      || right.occurrences - left.occurrences
      || right.maxAlphaStruct - left.maxAlphaStruct
      || left.files.join("\0").localeCompare(right.files.join("\0")),
    ),
  };
};

/**
 * Finds closed repeated multi-file co-change sets. A set is closed when no
 * larger file set is supported by the identical commits, avoiding redundant
 * pair/subset output from one batch. It is an investigation cue only.
 */
export const buildCochangeSetAnalysis = (history: EvolutionHistory, facts: FactByPath): CochangeSetAnalysis =>
  buildClosedCochangeAnalysis(history.changeSets, facts, { minimumSetSize: MIN_SET_SIZE, minimumSupport: MIN_SUPPORT });
