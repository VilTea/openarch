import type { EvolutionReviewReport, EvolutionSignalReport } from "@openarch/core";
import { type Locale, message } from "../i18n";

type CoordinationCandidate = EvolutionSignalReport["coordinationCandidates"][number];
type ExtensionSurfaceCandidate = EvolutionSignalReport["extensionSurfaces"]["candidates"][number];
type CochangeSetCandidate = EvolutionSignalReport["cochangeSets"]["candidates"][number];

const evidenceCommit = (entry: string): string => /^[a-f0-9]{13,}$/i.test(entry) ? entry.slice(0, 12) : entry;
const evidenceCommits = (entries: readonly string[], locale: Locale): string => entries.map(evidenceCommit).join(", ") || message(locale, "evolution.none");

const coordinationEvidenceRank = (candidate: CoordinationCandidate): number => {
  const status = candidate.historicalEvidence?.status;
  return status === "confirmed" ? 3 : status === "partial" ? 2 : status === "not_confirmed" ? 1 : 0;
};

const hasCoordinationSample = (candidate: CoordinationCandidate): boolean =>
  (candidate.historicalEvidence?.inspectedEvents ?? 0) > 0;

const structuralCorroboration = (candidate: ExtensionSurfaceCandidate): boolean =>
  candidate.currentInternalImportCount > 0 && candidate.currentImportComponents < candidate.files.length;

const extensionEvidenceRank = (candidate: ExtensionSurfaceCandidate): number => {
  const status = candidate.coordinationEvidence?.status;
  return status === "confirmed" ? 3 : status === "partial" ? 2 : status === "not_confirmed" ? 1 : 0;
};

const compareExtensionSurfaces = (left: ExtensionSurfaceCandidate, right: ExtensionSurfaceCandidate): number =>
  extensionEvidenceRank(right) - extensionEvidenceRank(left)
  || right.extensionCommitCount - left.extensionCommitCount
  || right.minimumMemberCoverage - left.minimumMemberCoverage
  || (right.files.length / right.averageBatchSize) - (left.files.length / left.averageBatchSize)
  || Number(structuralCorroboration(right)) - Number(structuralCorroboration(left))
  || left.files.join("\0").localeCompare(right.files.join("\0"));

interface ExtensionSurfaceGroup {
  readonly primary: ExtensionSurfaceCandidate;
  readonly variants: number;
}

const groupExtensionSurfaces = (candidates: readonly ExtensionSurfaceCandidate[]): ReadonlyMap<string, ExtensionSurfaceGroup> => {
  const grouped = new Map<string, ExtensionSurfaceCandidate[]>();
  for (const candidate of candidates) grouped.set(candidate.coordinator, [...(grouped.get(candidate.coordinator) ?? []), candidate]);
  return new Map([...grouped.entries()].map(([coordinator, surfaces]) => [
    coordinator,
    { primary: [...surfaces].sort(compareExtensionSurfaces)[0]!, variants: surfaces.length },
  ]));
};

interface CoordinationDossier {
  readonly coordination: CoordinationCandidate;
  readonly extension?: ExtensionSurfaceGroup;
}

const compareDossiers = (left: CoordinationDossier, right: CoordinationDossier): number =>
  coordinationEvidenceRank(right.coordination) - coordinationEvidenceRank(left.coordination)
  || Number(structuralCorroboration(right.extension?.primary ?? emptySurface)) - Number(structuralCorroboration(left.extension?.primary ?? emptySurface))
  || (right.extension?.primary.extensionCommitCount ?? 0) - (left.extension?.primary.extensionCommitCount ?? 0)
  || right.coordination.commitCount - left.coordination.commitCount
  || right.coordination.members.length - left.coordination.members.length
  || right.coordination.maxAlphaStruct - left.coordination.maxAlphaStruct
  || left.coordination.coordinator.localeCompare(right.coordination.coordinator);

const emptySurface = {
  currentInternalImportCount: 0,
  currentImportComponents: 1,
  extensionCommitCount: 0,
} as ExtensionSurfaceCandidate;

const coordinationHistory = (candidate: CoordinationCandidate, locale: Locale): string => {
  const evidence = candidate.historicalEvidence;
  return evidence
    ? message(locale, "evolution.history", { status: evidence.status.toUpperCase(), confirmed: evidence.confirmedEvents, inspected: evidence.inspectedEvents })
    : "UNAVAILABLE";
};

const renderExtension = (locale: Locale, group: ExtensionSurfaceGroup | undefined, availability: EvolutionSignalReport["extensionSurfaces"]): readonly string[] => {
  if (!group) {
    return availability.availability === "unavailable"
      ? [message(locale, "evolution.surfaceUnavailable", { reason: availability.reason ?? message(locale, "evolution.enumerationIncomplete") })]
      : [message(locale, "evolution.surfaceAbsent")];
  }
  const candidate = group.primary;
  const corroboration = structuralCorroboration(candidate)
    ? message(locale, "evolution.structureConfirmed", { imports: candidate.currentInternalImportCount, components: candidate.currentImportComponents })
    : message(locale, "evolution.structureLimited");
  return [
    message(locale, "evolution.surface", { files: candidate.files.join(" + "), commits: candidate.extensionCommitCount, members: candidate.extensionMembers.length }),
    message(locale, "evolution.members", { members: candidate.extensionMembers.join(", "), corroboration }),
    ...(group.variants > 1 ? [message(locale, "evolution.variants", { count: group.variants - 1 })] : []),
    message(locale, "evolution.evidenceCommits", { commits: evidenceCommits(candidate.historyEntries, locale) }),
  ];
};

const renderDossier = (
  dossier: CoordinationDossier,
  index: number,
  extensionAnalysis: EvolutionSignalReport["extensionSurfaces"], locale: Locale,
): readonly string[] => {
  const candidate = dossier.coordination;
  const hasActionableSurface = dossier.extension && structuralCorroboration(dossier.extension.primary);
  return [
    `### ${index + 1}. ${candidate.coordinator}`,
    message(locale, "evolution.integration", { commits: candidate.commitCount, members: candidate.members.length }),
    message(locale, "evolution.membersOnly", { members: candidate.members.join(", ") }),
    message(locale, "evolution.coordinationHistory", { history: coordinationHistory(candidate, locale), imports: candidate.directImportCount }),
    message(locale, "evolution.coordinatorCommits", { commits: evidenceCommits(candidate.historyEntries, locale) }),
    ...renderExtension(locale, dossier.extension, extensionAnalysis),
    message(locale, hasActionableSurface ? "evolution.actionableInvestigation" : "evolution.insufficientInvestigation"),
  ];
};

const renderDeferredDossiers = (locale: Locale, candidates: readonly CoordinationCandidate[]): readonly string[] => {
  if (candidates.length === 0) return [];
  return [
    message(locale, "evolution.deferredHeading"), message(locale, "evolution.deferred", { count: candidates.length }),
    ...candidates.slice(0, 5).map((candidate) => message(locale, "evolution.deferredItem", { coordinator: candidate.coordinator, commits: candidate.commitCount, members: candidate.members.length })),
  ];
};

const actionSummary = (candidate: CochangeSetCandidate, locale: Locale): string => {
  const action = candidate.actionSummary;
  return action.observedCommits === 0 ? message(locale, "evolution.gitUnavailable") : `A/M/D=${action.added}/${action.modified}/${action.deleted}`;
};

const renderCochangeBackground = (report: EvolutionSignalReport, locale: Locale): readonly string[] => {
  const analysis = report.cochangeSets;
  if (analysis.availability === "unavailable") return [message(locale, "evolution.cochangeHeading"), message(locale, "evolution.cochangeUnavailable", { reason: analysis.reason ?? message(locale, "evolution.enumerationIncomplete") })];
  if (analysis.candidates.length === 0) return [];
  return [
    message(locale, "evolution.cochangeHeading"), message(locale, "evolution.cochangeSummary", { count: analysis.candidates.length }),
    ...analysis.candidates.slice(0, 5).map((candidate) =>
      message(locale, "evolution.cochangeItem", { files: candidate.files.length, occurrences: candidate.occurrences, members: candidate.files.join(" + "), action: actionSummary(candidate, locale), imports: candidate.currentInternalImportCount }),
    ),
  ];
};

export const renderEvolutionUnavailable = (reason: string, locale: Locale = "zh"): readonly string[] => [
  message(locale, "evolution.heading"), message(locale, "evolution.statusUnavailable"), message(locale, "evolution.reason", { reason }), message(locale, "evolution.noGitEvidence"),
];

export const renderEvolutionReport = (report: EvolutionSignalReport | EvolutionReviewReport, locale: Locale = "zh"): readonly string[] => {
  const extensions = groupExtensionSurfaces(report.extensionSurfaces.candidates);
  const sampled = report.coordinationCandidates
    .filter((candidate) => hasCoordinationSample(candidate) && candidate.historicalEvidence?.status !== "unavailable")
    .map((coordination) => ({ coordination, extension: extensions.get(coordination.coordinator) }))
    .sort(compareDossiers);
  const deferred = report.coordinationCandidates
    .filter((candidate) => !hasCoordinationSample(candidate) || candidate.historicalEvidence?.status === "unavailable");
  const enrichment = "enrichment" in report ? report.enrichment : undefined;
  const extensionSurfaceCount = report.extensionSurfaces.candidates.length;
  const linkedSurfaceCount = [...extensions.values()].filter((group) => structuralCorroboration(group.primary)).length;

  return [
    message(locale, "evolution.heading"), message(locale, "evolution.eligible", { count: report.eligibleChangeSets }),
    ...(report.bootstrapChangeSetsExcluded > 0 ? [message(locale, "evolution.bootstrapExcluded", { count: report.bootstrapChangeSetsExcluded })] : []),
    ...(report.unavailableHistoryFiles > 0 ? [message(locale, "evolution.historyExcluded", { count: report.unavailableHistoryFiles })] : []),
    ...(report.relationFacts ? [message(locale, "evolution.relationUnavailable", { reason: report.relationFacts.reason })] : []),
    message(locale, "evolution.dossierSummary", { sampled: sampled.length, deferred: deferred.length, linked: linkedSurfaceCount, surfaces: extensions.size, projections: extensionSurfaceCount }), message(locale, "evolution.disclaimer"),
    ...(enrichment ? [message(locale, "evolution.budget", { candidates: enrichment.candidatesSelected, events: enrichment.eventsSelected, budget: enrichment.eventBudget, confirmed: enrichment.confirmedEvents, unavailable: enrichment.unavailableEvents })] : []),
    ...(sampled.length === 0 ? [message(locale, "evolution.noDossiers")] : [message(locale, "evolution.queueHeading"), ...sampled.slice(0, 5).flatMap((dossier, index) => renderDossier(dossier, index, report.extensionSurfaces, locale))]),
    ...renderDeferredDossiers(locale, deferred), ...renderCochangeBackground(report, locale),
  ];
};
