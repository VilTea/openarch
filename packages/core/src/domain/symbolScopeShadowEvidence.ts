import type { GovernanceAvailability } from "./governance";
import type { ChangeKind } from "./weights";
import type { SymbolCalibrationProfile } from "./symbolCalibration";
import { symbolCommonPopulationFingerprint } from "./symbolCalibration";
import { computeSymbolScopeMetric, type SymbolScopeMetricResult } from "./symbolScopeMetric";
import type { SymbolDeclarationPair, SymbolVersionPairReport } from "./symbolVersionPair";
import { symbolUseDeclarationFamily, type SymbolUseFact } from "../symbol-use/types";

/**
 * Structural inputs are supplied by the historical semantic-diff workflow.
 * They deliberately stay outside SymbolVersionPairReport: version providers
 * establish symbol facts, while the impact model owns change classification
 * and structural weights.
 */
export interface SymbolScopeHistoricalStructuralInput {
  readonly identity: string;
  readonly changeKind: ChangeKind;
  readonly alphaStruct: number;
  readonly layerWeight: number;
  readonly staticImportConsumers?: readonly string[];
}

export interface SymbolScopeShadowEvidenceItem {
  readonly identity: string;
  readonly pairStatus: SymbolDeclarationPair["status"] | "missing";
  /** Matched and added declarations use after references; removals use before references. */
  readonly referenceRevision?: "before" | "after";
  readonly availability: GovernanceAvailability;
  readonly calibrationProfileId?: string;
  readonly metric?: SymbolScopeMetricResult;
  readonly reasons: readonly string[];
}

export interface SymbolScopeShadowEvidenceReport {
  readonly language: string;
  readonly beforeRevision: string;
  readonly afterRevision: string;
  readonly commonPopulationFingerprint: string;
  readonly availability: GovernanceAvailability;
  readonly items: readonly SymbolScopeShadowEvidenceItem[];
  readonly reasons: readonly string[];
}

const finiteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;

const evidenceAvailability = (reasons: readonly string[]): GovernanceAvailability =>
  reasons.length === 0 ? "available" : reasons.every((reason) => reason.startsWith("unavailable:")) ? "unavailable" : "partial";

const selectedFact = (pair: SymbolDeclarationPair): { readonly fact: SymbolUseFact; readonly revision: "before" | "after" } | undefined => {
  if (pair.status === "removed" && pair.before) return { fact: pair.before, revision: "before" };
  if ((pair.status === "matched" || pair.status === "added") && pair.after) return { fact: pair.after, revision: "after" };
  return undefined;
};

const profileFor = (
  profiles: readonly SymbolCalibrationProfile[],
  language: string,
  providerId: string,
  declarationFamily: ReturnType<typeof symbolUseDeclarationFamily>,
  commonPopulationFingerprint: string,
): { readonly profile?: SymbolCalibrationProfile; readonly reason?: string } => {
  const matches = profiles.filter((profile) =>
    profile.eligible
    && profile.language === language
    && profile.providerId === providerId
    && profile.declarationFamily === declarationFamily
    && profile.commonPopulationFingerprint === commonPopulationFingerprint,
  );
  if (matches.length === 1) return { profile: matches[0] };
  if (matches.length > 1) return { reason: "multiple eligible calibration profiles match this evidence identity" };
  return { reason: "no eligible calibration profile matches language, provider, declaration family and common population" };
};

const providerReasons = (report: SymbolVersionPairReport, revision: "before" | "after"): readonly string[] => {
  const selected = revision === "before" ? report.before : report.after;
  const other = revision === "before" ? report.after : report.before;
  return [
    report.availability === "unavailable" ? "unavailable: version-pair report is unavailable" : undefined,
    report.availability === "partial" ? "version-pair report is partial" : undefined,
    !selected ? `unavailable: ${revision} symbol report is absent` : undefined,
    selected?.state.availability === "unavailable" ? `unavailable: ${revision} symbol report is unavailable` : undefined,
    selected?.state.availability === "partial" ? `${revision} symbol report is partial` : undefined,
    !other ? "unavailable: paired revision symbol report is absent" : undefined,
    other?.state.availability === "unavailable" ? "unavailable: paired revision symbol report is unavailable" : undefined,
    other?.state.availability === "partial" ? "paired revision symbol report is partial" : undefined,
    selected?.state.coverage.declarations !== "complete" || other?.state.coverage.declarations !== "complete"
      ? "declaration coverage is incomplete across the version pair" : undefined,
    selected?.state.coverage.repositoryReferences !== "complete" || other?.state.coverage.repositoryReferences !== "complete"
      ? "repository reference coverage is incomplete across the version pair" : undefined,
    selected && other && selected.origin.providerId !== other.origin.providerId
      ? "before and after symbol providers do not match" : undefined,
  ].filter((reason): reason is string => Boolean(reason));
};

const evaluateItem = (
  report: SymbolVersionPairReport,
  input: SymbolScopeHistoricalStructuralInput,
  profiles: readonly SymbolCalibrationProfile[],
  commonPopulationFingerprint: string,
): SymbolScopeShadowEvidenceItem => {
  const pair = report.declarations.find((candidate) => candidate.identity === input.identity);
  if (!pair) {
    return { identity: input.identity, pairStatus: "missing", availability: "unavailable", reasons: ["unavailable: historical declaration identity was not observed"] };
  }
  if (pair.status === "ambiguous") {
    return { identity: input.identity, pairStatus: pair.status, availability: "partial", reasons: [pair.reason ?? "historical declaration identity is ambiguous"] };
  }
  const selected = selectedFact(pair);
  if (!selected) {
    return { identity: input.identity, pairStatus: pair.status, availability: "partial", reasons: [pair.reason ?? "selected historical declaration fact is absent"] };
  }
  const source = selected.revision === "before" ? report.before : report.after;
  const providerId = source?.origin.providerId;
  const declarationFamily = symbolUseDeclarationFamily(selected.fact.declaration.kind);
  const profileMatch = providerId
    ? profileFor(profiles, report.language, providerId, declarationFamily, commonPopulationFingerprint)
    : { reason: "unavailable: selected revision has no symbol provider identity" };
  const reasons = [
    ...providerReasons(report, selected.revision),
    !finiteNonNegative(input.alphaStruct) ? "alpha_struct must be finite and non-negative" : undefined,
    !finiteNonNegative(input.layerWeight) ? "layer weight must be finite and non-negative" : undefined,
    selected.fact.publicSurface === "unknown" ? "public surface is unknown" : undefined,
    profileMatch.reason,
  ].filter((reason): reason is string => Boolean(reason));
  const availability = evidenceAvailability(reasons);
  if (availability !== "available" || !source || !profileMatch.profile) {
    return {
      identity: input.identity, pairStatus: pair.status, referenceRevision: selected.revision, availability,
      ...(profileMatch.profile ? { calibrationProfileId: profileMatch.profile.id } : {}), reasons,
    };
  }
  const metric = computeSymbolScopeMetric({
    language: report.language,
    providerId: source.origin.providerId,
    file: selected.fact.declaration.file,
    symbol: selected.fact.declaration.name,
    declarationFamily,
    changeKind: input.changeKind,
    alphaStruct: input.alphaStruct,
    layerWeight: input.layerWeight,
    repositoryReferences: selected.fact.repositoryReferences.map((reference) => reference.file),
    ...(input.staticImportConsumers ? { staticImportConsumers: input.staticImportConsumers } : {}),
    declarationsCoverage: source.state.coverage.declarations,
    repositoryReferencesCoverage: source.state.coverage.repositoryReferences,
    publicSurface: selected.fact.publicSurface,
    commonPopulationFingerprint,
    calibrationProfile: profileMatch.profile,
  });
  return {
    identity: input.identity, pairStatus: pair.status, referenceRevision: selected.revision,
    availability: metric.availability, calibrationProfileId: profileMatch.profile.id, metric, reasons: metric.reasons,
  };
};

/**
 * Evaluates historical symbol scope only from bounded version-pair evidence.
 * It has no dependency on DiffReport, baseline/history storage, I_push or policy.
 */
export const evaluateSymbolScopeShadowEvidence = (input: {
  readonly report: SymbolVersionPairReport;
  readonly structuralInputs: readonly SymbolScopeHistoricalStructuralInput[];
  readonly calibrationProfiles: readonly SymbolCalibrationProfile[];
}): SymbolScopeShadowEvidenceReport => {
  const commonPopulationFingerprint = symbolCommonPopulationFingerprint(input.report.population.files);
  const duplicateIds = new Set(input.structuralInputs
    .map((item) => item.identity)
    .filter((identity, index, values) => values.indexOf(identity) !== index));
  const items = input.structuralInputs.map((structuralInput) => duplicateIds.has(structuralInput.identity)
    ? {
      identity: structuralInput.identity, pairStatus: "missing" as const, availability: "partial" as const,
      reasons: ["multiple structural inputs share one historical declaration identity"],
    }
    : evaluateItem(input.report, structuralInput, input.calibrationProfiles, commonPopulationFingerprint));
  const reasons = [
    input.report.availability !== "available" ? input.report.reason ?? `version-pair report is ${input.report.availability}` : undefined,
    input.structuralInputs.length === 0 ? "no historical structural inputs were supplied" : undefined,
  ].filter((reason): reason is string => Boolean(reason));
  const availability = items.some((item) => item.availability === "available")
    ? "available"
    : items.length > 0 && items.every((item) => item.availability === "unavailable")
      ? "unavailable"
      : "partial";
  return {
    language: input.report.language,
    beforeRevision: input.report.population.beforeRevision,
    afterRevision: input.report.population.afterRevision,
    commonPopulationFingerprint,
    availability: reasons.length > 0 && availability === "available" ? "partial" : availability,
    items,
    reasons,
  };
};
