import { createHash } from "node:crypto";
import type { Language } from "./ast";
import { symbolUseDeclarationFamily, type SymbolUseDeclarationFamily } from "../symbol-use/types";
import type { SymbolVersionPairReport } from "./symbolVersionPair";
import { supportsPersistedVersion, type PersistedVersionBoundary } from "./persistenceBoundary";

/** A profile is an independent durable record, so a missing/unknown version rejects it. */
export const SYMBOL_CALIBRATION_SCHEMA_BOUNDARY = {
  classification: "persisted",
  storage: "symbol-calibration-profile",
  version: 1,
  unknownVersion: "reject",
  missingVersion: "reject",
} as const satisfies PersistedVersionBoundary<1>;

export const SYMBOL_CALIBRATION_SCHEMA_VERSION = SYMBOL_CALIBRATION_SCHEMA_BOUNDARY.version;

export type SymbolCalibrationExpectation = "matched" | "rejected";
export type SymbolCalibrationObservation = SymbolCalibrationExpectation | "ambiguous" | "unavailable";
export type SymbolCalibrationAvailability = "available" | "partial" | "unavailable";
export type SymbolCalibrationDeclarationFamily = SymbolUseDeclarationFamily | "unknown";

export interface SymbolCalibrationSample {
  readonly id: string;
  readonly language: Language;
  readonly providerId: string;
  readonly declarationFamily: SymbolCalibrationDeclarationFamily;
  /** Fingerprint of the shared file set, deliberately independent of revisions. */
  readonly commonPopulationFingerprint: string;
  readonly expected: SymbolCalibrationExpectation;
  readonly observed: SymbolCalibrationObservation;
  readonly availability: SymbolCalibrationAvailability;
  readonly reason?: string;
}

export interface SymbolCalibrationProfile {
  readonly schemaVersion: typeof SYMBOL_CALIBRATION_SCHEMA_VERSION;
  readonly id: string;
  readonly language: Language;
  readonly providerId: string;
  readonly declarationFamily: SymbolCalibrationDeclarationFamily;
  readonly commonPopulationFingerprint: string;
  readonly samples: readonly SymbolCalibrationSample[];
  readonly positiveSampleCount: number;
  readonly negativeSampleCount: number;
  readonly availability: SymbolCalibrationAvailability;
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A population identity excludes revisions so multiple pairs can share one fixed denominator. */
export const symbolCommonPopulationFingerprint = (files: readonly string[]): string =>
  hash({ definition: "symbol-calibration-population", files: [...new Set(files)].sort() });

const declarationFamily = (report: SymbolVersionPairReport, identity: string): SymbolCalibrationDeclarationFamily => {
  const pair = report.declarations.find((candidate) => candidate.identity === identity);
  const families = new Set([pair?.before, pair?.after]
    .filter((fact): fact is NonNullable<typeof fact> => Boolean(fact))
    .map((fact) => symbolUseDeclarationFamily(fact.declaration.kind)));
  return families.size === 1 ? [...families][0]! : "unknown";
};

const observationFor = (report: SymbolVersionPairReport, identity: string): SymbolCalibrationObservation => {
  const pair = report.declarations.find((candidate) => candidate.identity === identity);
  if (!pair) return "unavailable";
  if (pair.status === "matched") return "matched";
  if (pair.status === "added" || pair.status === "removed") return "rejected";
  return "ambiguous";
};

const coverageAvailable = (report: SymbolVersionPairReport): boolean =>
  report.availability === "available"
  && report.before?.state.availability === "available"
  && report.after?.state.availability === "available"
  && report.before.state.coverage.declarations === "complete"
  && report.before.state.coverage.repositoryReferences === "complete"
  && report.after.state.coverage.declarations === "complete"
  && report.after.state.coverage.repositoryReferences === "complete";

/** Converts one version pair into a durable, source-free calibration observation. */
export const createSymbolCalibrationSample = (
  report: SymbolVersionPairReport,
  input: { readonly id: string; readonly identity: string; readonly expected: SymbolCalibrationExpectation },
): SymbolCalibrationSample => {
  const family = declarationFamily(report, input.identity);
  const providerIds = new Set([
    report.before?.origin.providerId,
    report.after?.origin.providerId,
  ].filter((providerId): providerId is string => Boolean(providerId)));
  const observed = observationFor(report, input.identity);
  const available = coverageAvailable(report);
  const reasons = [
    !report.population.files.length ? "version pair has no common governed population" : undefined,
    family === "unknown" ? "version pair declaration family is not unique" : undefined,
    providerIds.size > 1 ? "before and after providers do not match" : undefined,
    !available ? report.reason ?? "provider or coverage is not complete on both revisions" : undefined,
    observed === "unavailable" ? "target declaration identity was not observed" : undefined,
    observed === "ambiguous" ? "target declaration identity is ambiguous" : undefined,
  ].filter((reason): reason is string => Boolean(reason));
  return {
    id: input.id,
    language: report.language,
    providerId: providerIds.size === 1 ? [...providerIds][0]! : "none",
    declarationFamily: family,
    commonPopulationFingerprint: symbolCommonPopulationFingerprint(report.population.files),
    expected: input.expected,
    observed,
    availability: available && reasons.length === 0 ? "available" : report.availability === "unavailable" ? "unavailable" : "partial",
    ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
  };
};

const profileAvailability = (samples: readonly SymbolCalibrationSample[], reasons: readonly string[]): SymbolCalibrationAvailability => {
  if (samples.length === 0) return "unavailable";
  if (reasons.length === 0 && samples.every((sample) => sample.availability === "available")) return "available";
  return samples.every((sample) => sample.availability === "unavailable") ? "unavailable" : "partial";
};

const sampleIdentityReasons = (sample: SymbolCalibrationSample, first: SymbolCalibrationSample): readonly string[] => [
  sample.language !== first.language || sample.providerId !== first.providerId || sample.declarationFamily !== first.declarationFamily
    ? "samples must share language, provider and declaration family" : undefined,
  sample.commonPopulationFingerprint !== first.commonPopulationFingerprint
    ? "samples must share one common population fingerprint" : undefined,
  sample.declarationFamily === "unknown" ? `sample ${sample.id} has no unique declaration family` : undefined,
].filter((reason): reason is string => Boolean(reason));

const sampleEvidenceReasons = (sample: SymbolCalibrationSample): readonly string[] => [
  sample.availability !== "available" ? `sample ${sample.id} is ${sample.availability}` : undefined,
  sample.observed !== sample.expected ? `sample ${sample.id} disagrees with its expected outcome` : undefined,
].filter((reason): reason is string => Boolean(reason));

/** Builds one fixed-population profile; mismatched samples remain visible but cannot become eligible. */
export const buildSymbolCalibrationProfile = (samples: readonly SymbolCalibrationSample[]): SymbolCalibrationProfile => {
  const first = samples[0];
  const reasons: string[] = [];
  if (!first) {
    return {
      schemaVersion: SYMBOL_CALIBRATION_SCHEMA_VERSION, id: "symbol-calibration:empty",
      language: "typescript", providerId: "none", declarationFamily: "unknown", commonPopulationFingerprint: "",
      samples: [], positiveSampleCount: 0, negativeSampleCount: 0, availability: "unavailable", eligible: false,
      reasons: ["at least one calibration sample is required"],
    };
  }
  const ids = new Set<string>();
  for (const sample of samples) {
    if (ids.has(sample.id)) reasons.push(`duplicate sample id: ${sample.id}`);
    ids.add(sample.id);
    reasons.push(...sampleIdentityReasons(sample, first), ...sampleEvidenceReasons(sample));
  }
  const positiveSampleCount = samples.filter((sample) => sample.expected === "matched" && sample.observed === "matched").length;
  const negativeSampleCount = samples.filter((sample) => sample.expected === "rejected" && sample.observed === "rejected").length;
  if (positiveSampleCount === 0) reasons.push("at least one confirmed matched positive sample is required");
  if (negativeSampleCount === 0) reasons.push("at least one confirmed rejected negative sample is required");
  const uniqueReasons = [...new Set(reasons)];
  const availability = profileAvailability(samples, uniqueReasons);
  return {
    schemaVersion: SYMBOL_CALIBRATION_SCHEMA_VERSION,
    id: `symbol-calibration:${hash({ language: first.language, providerId: first.providerId, declarationFamily: first.declarationFamily, commonPopulationFingerprint: first.commonPopulationFingerprint, sampleIds: samples.map((sample) => sample.id).sort() })}`,
    language: first.language,
    providerId: first.providerId,
    declarationFamily: first.declarationFamily,
    commonPopulationFingerprint: first.commonPopulationFingerprint,
    samples,
    positiveSampleCount,
    negativeSampleCount,
    availability,
    eligible: availability === "available",
    reasons: uniqueReasons,
  };
};

/** JSON round-trip validation keeps persisted profiles source-free and versioned. */
export const parseSymbolCalibrationProfile = (value: unknown): SymbolCalibrationProfile => {
  if (!value || typeof value !== "object" || !supportsPersistedVersion(SYMBOL_CALIBRATION_SCHEMA_BOUNDARY, (value as { schemaVersion?: unknown }).schemaVersion)) {
    throw new Error("invalid symbol calibration profile schema");
  }
  const profile = value as Partial<SymbolCalibrationProfile>;
  if (
    typeof profile.id !== "string"
    || typeof profile.language !== "string"
    || typeof profile.providerId !== "string"
    || !["callable", "type", "property", "unknown"].includes(profile.declarationFamily ?? "")
    || typeof profile.commonPopulationFingerprint !== "string"
    || !Array.isArray(profile.samples)
    || !profile.samples.every((sample) => (
      Boolean(sample)
      && typeof sample === "object"
      && typeof (sample as SymbolCalibrationSample).id === "string"
      && typeof (sample as SymbolCalibrationSample).language === "string"
      && typeof (sample as SymbolCalibrationSample).providerId === "string"
      && ["callable", "type", "property", "unknown"].includes((sample as SymbolCalibrationSample).declarationFamily)
      && typeof (sample as SymbolCalibrationSample).commonPopulationFingerprint === "string"
      && ["matched", "rejected"].includes((sample as SymbolCalibrationSample).expected)
      && ["matched", "rejected", "ambiguous", "unavailable"].includes((sample as SymbolCalibrationSample).observed)
      && ["available", "partial", "unavailable"].includes((sample as SymbolCalibrationSample).availability)
    ))
  ) throw new Error("invalid symbol calibration profile fields");
  return profile as SymbolCalibrationProfile;
};
