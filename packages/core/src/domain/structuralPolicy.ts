import type { CRLStateWeights, P95Values } from "./crlState";
import { gateCalibrationProfile, type StructuralCalibrationState } from "./calibration";
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

/**
 * Gate 与 D_MR 共用的 per-file 校准选择（校准 2026-08-15）：
 * 文件恰好归属一条 policy 时使用该 policy 的 sealed P95 与权重；
 * 零匹配/多匹配/无 policy 标定回退 legacy 全局 P95 与默认权重。
 * 该规则消除 diff D_MR 与 gate crl_local 的"同族语义、不同数值"漂移。
 */
export const calibrationForSubject = (
  subject: StructuralPolicySubject | undefined,
  policies: readonly StructuralPolicy[],
  calibrations: Readonly<Record<string, StructuralCalibrationState>> | undefined,
  fallbackP95: P95Values | undefined,
  fallbackWeights: CRLStateWeights,
): { readonly p95: P95Values | undefined; readonly weights: CRLStateWeights } => {
  const matches = subject ? policiesForSubject(policies, subject) : [];
  if (matches.length !== 1) return { p95: fallbackP95, weights: fallbackWeights };
  const policy = matches[0];
  return {
    p95: gateCalibrationProfile(calibrations?.[policy.id])?.p95 ?? fallbackP95,
    weights: policy.crlStateWeights,
  };
};
