export type EvidenceLevel = "observed" | "reviewed" | "confirmed";
export type EvidenceVerdict = "PASS" | "WARN" | "BLOCK";

/** Cross-project aggregate only. Paths, source, finding text, policy text, and identities are intentionally absent. */
export interface ValidationEvidence {
  readonly schemaVersion: "2";
  readonly projectToken: string;
  readonly observedAt: string;
  readonly window: { readonly startedAt: string; readonly endedAt: string };
  readonly openarchVersion: string;
  readonly languages: readonly string[];
  readonly provider: { readonly id: string; readonly version: string };
  /** Stable, opaque calibration key. It identifies a rule and its declared authority, never a path or source artifact. */
  readonly ruleId: string;
  readonly authorityId: string;
  readonly findingCount: number;
  readonly policyVerdict: EvidenceVerdict;
  readonly confirmedFalsePositiveCount: number;
  readonly confirmedFalseNegativeCount: number;
  readonly evidenceLevel: EvidenceLevel;
}

const validTime = (value: string): boolean => Number.isFinite(Date.parse(value));
const validCalibrationIdentifier = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value);

export const validateValidationEvidence = (value: ValidationEvidence): ValidationEvidence => {
  if (!value.projectToken.trim() || !value.openarchVersion.trim() || !value.provider.id.trim() || !value.provider.version.trim()) throw new Error("ValidationEvidence requires non-empty project and provider identifiers");
  if (!validCalibrationIdentifier(value.provider.id) || !validCalibrationIdentifier(value.ruleId) || !validCalibrationIdentifier(value.authorityId)) throw new Error("ValidationEvidence requires stable provider, rule, and authority identifiers");
  if (!value.languages.length || value.languages.some((language) => !language.trim())) throw new Error("ValidationEvidence requires at least one language");
  if (![value.observedAt, value.window.startedAt, value.window.endedAt].every(validTime)) throw new Error("ValidationEvidence contains an invalid timestamp");
  if (Date.parse(value.window.startedAt) > Date.parse(value.window.endedAt)) throw new Error("ValidationEvidence window starts after it ends");
  if (![value.findingCount, value.confirmedFalsePositiveCount, value.confirmedFalseNegativeCount].every((count) => Number.isInteger(count) && count >= 0)) throw new Error("ValidationEvidence counts must be non-negative integers");
  return value;
};
