import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GovernanceObservation {
  readonly status: "success";
  readonly at: string;
  readonly inputFingerprint: string;
}

export interface GovernanceObservationStore {
  readonly version: "1";
  readonly operations: Readonly<Record<string, GovernanceObservation>>;
}

const OBSERVATION_PATH = ".openarch/governance-observations.v1.json";
const OBSERVATION_IGNORE = "governance-observations.v1.json";

export const governanceObservationPath = (scopeRoot: string): string => join(scopeRoot, OBSERVATION_PATH);

const ensureObservationIgnored = (scopeRoot: string): void => {
  const ignorePath = join(scopeRoot, ".openarch", ".gitignore");
  const existing = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8").split(/\r?\n/).filter(Boolean) : [];
  if (!existing.includes(OBSERVATION_IGNORE)) writeFileSync(ignorePath, `${[...existing, OBSERVATION_IGNORE].join("\n")}\n`, "utf8");
};

export const readGovernanceObservation = (scopeRoot: string, operation: string): GovernanceObservation | undefined => {
  try {
    const value = JSON.parse(readFileSync(governanceObservationPath(scopeRoot), "utf8")) as GovernanceObservationStore;
    return value.version === "1" ? value.operations?.[operation] : undefined;
  } catch {
    return undefined;
  }
};

export const recordGovernanceObservation = (scopeRoot: string, operation: string, observation: GovernanceObservation): void => {
  const path = governanceObservationPath(scopeRoot);
  let existing: GovernanceObservationStore = { version: "1", operations: {} };
  if (existsSync(path)) {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as GovernanceObservationStore;
      if (value.version === "1" && value.operations) existing = value;
    } catch { /* replace invalid runtime projection */ }
  }
  mkdirSync(dirname(path), { recursive: true });
  ensureObservationIgnored(scopeRoot);
  writeFileSync(path, `${JSON.stringify({ version: "1", operations: { ...existing.operations, [operation]: observation } }, null, 2)}\n`, "utf8");
};
