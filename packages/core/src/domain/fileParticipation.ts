import type { FileKind } from "./testGovernance";

/**
 * Fixed product concerns, deliberately separate from project path configuration.
 * Projects classify artifacts once; consumers declare which governed population
 * they need without inventing another path filter.
 */
export const GOVERNANCE_POPULATIONS = [
  "observed",
  "production-governance",
  "test-governance",
  "change-evidence",
] as const;

export type GovernancePopulation = typeof GOVERNANCE_POPULATIONS[number];

/** Legacy baseline entries predate fileKind and are conservatively production. */
export const effectiveFileKind = (fileKind: FileKind | undefined): FileKind => fileKind ?? "production";

export const participatesInPopulation = (
  fileKind: FileKind | undefined,
  population: GovernancePopulation,
): boolean => {
  const effective = effectiveFileKind(fileKind);
  switch (population) {
    case "observed":
      return true;
    case "production-governance":
      return effective === "production";
    case "test-governance":
      return effective === "test";
    case "change-evidence":
      return effective === "production" || effective === "test";
  }
};
