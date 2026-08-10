import type { CRLStateWeights } from "./crlState";
import { minimatch } from "minimatch";
import { toPosixPath } from "../infra/paths";

export type StructuralPolicyMode = "observe" | "enforce";

export interface StructuralPolicyRule {
  readonly name: string;
  readonly condition: string;
  readonly level: "block" | "warn";
}

/** Optional project-relative boundary for separate services or areas using one language. */
export interface StructuralPolicyScope {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

/**
 * A policy population is the boundary within which structural distributions
 * and thresholds are comparable. It is deliberately separate from pathClass:
 * language describes parser semantics; pathClass describes project topology.
 */
export interface StructuralPolicy {
  readonly id: string;
  readonly languages: readonly string[];
  readonly scope?: StructuralPolicyScope;
  readonly mode: StructuralPolicyMode;
  readonly rules: readonly StructuralPolicyRule[];
  readonly crlStateWeights: CRLStateWeights;
}

export interface StructuralPolicySubject {
  readonly path: string;
  readonly language: string;
}

const repositoryPath = (path: string): string => toPosixPath(path).replace(/^\.\/+/u, "");
const matchesAny = (path: string, patterns: readonly string[] | undefined): boolean =>
  !!patterns?.some((pattern) => minimatch(path, pattern, { dot: true }));

/** One shared population selector for scan calibration and gate evaluation. */
export const matchesStructuralPolicy = (policy: StructuralPolicy, subject: StructuralPolicySubject): boolean => {
  if (!policy.languages.includes(subject.language)) return false;
  const path = repositoryPath(subject.path);
  if (policy.scope?.include && !matchesAny(path, policy.scope.include)) return false;
  return !matchesAny(path, policy.scope?.exclude);
};

export const policiesForSubject = (policies: readonly StructuralPolicy[], subject: StructuralPolicySubject): readonly StructuralPolicy[] =>
  policies.filter((policy) => matchesStructuralPolicy(policy, subject));
