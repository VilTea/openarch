import type { GovernanceAvailability } from "./governance";

export type SymbolScopeAdmissionRequirementId =
  | "before_declaration_identity"
  | "after_declaration_identity"
  | "repository_references"
  | "public_surface"
  | "common_population"
  | "calibration_samples";

export interface SymbolScopeAdmissionRequirement {
  readonly id: SymbolScopeAdmissionRequirementId;
  readonly availability: GovernanceAvailability;
  readonly reason?: string;
}

export interface SymbolScopeImpactAdmission {
  readonly language: string;
  readonly providerId: string;
  readonly file: string;
  readonly symbol: string;
  readonly availability: GovernanceAvailability;
  readonly eligible: boolean;
  readonly requirements: readonly SymbolScopeAdmissionRequirement[];
}

const availabilityOf = (requirements: readonly SymbolScopeAdmissionRequirement[]): GovernanceAvailability => {
  if (requirements.every((requirement) => requirement.availability === "available")) return "available";
  return requirements.every((requirement) => requirement.availability === "unavailable") ? "unavailable" : "partial";
};

/**
 * A symbol-scope impact formula may be considered only after every evidence
 * requirement is complete. This is a report-only admission decision, never a
 * metric or policy projection.
 */
export const assessSymbolScopeImpactAdmission = (
  input: Omit<SymbolScopeImpactAdmission, "availability" | "eligible">,
): SymbolScopeImpactAdmission => {
  const availability = availabilityOf(input.requirements);
  return {
    ...input,
    availability,
    eligible: availability === "available",
  };
};
