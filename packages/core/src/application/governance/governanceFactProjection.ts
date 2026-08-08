import type { FactResultLike, FactSnapshot, Finding, Signal } from "../../domain/governance";
import type { GovernanceDiagnosticsReport } from "./governanceDiagnostics";

export interface FactProjection {
  readonly scope: FactResultLike<{ readonly fingerprint: string }>;
  /** 域 → 类型化载荷（与脚本侧 ProjectFacts 同构）。 */
  readonly facts: Readonly<Record<string, FactResultLike<unknown>>>;
  readonly findings: readonly Finding[];
  readonly signals: readonly Signal[];
}

/** Projects gate/review/anti-pattern producer output without interpreting project policy.
 *  域 → 专用字段：每个治理域一个类型化槽位（校准 2026-08-08 第二轮）。 */
export const projectGovernanceFacts = (diagnostics: GovernanceDiagnosticsReport): FactProjection => {
  const scope: FactResultLike<{ readonly fingerprint: string }> = diagnostics.gate.analysisScopeFingerprint
    ? { availability: "available", value: { fingerprint: diagnostics.gate.analysisScopeFingerprint } }
    : { availability: "unavailable", reason: "gate did not establish an analysis scope" };
  const facts: Readonly<Record<string, FactResultLike<unknown>>> = {
    "architecture-policy": diagnostics.gate.verdict === "UNAVAILABLE"
      ? { availability: "unavailable", reason: diagnostics.gate.diagnostic ? `${diagnostics.gate.diagnostic.category}/${diagnostics.gate.diagnostic.operation}: ${diagnostics.gate.diagnostic.message}` : "gate policy evidence is unavailable" }
      : { availability: "available", value: diagnostics.gate },
    "structure-review": diagnostics.review.hasData
      ? { availability: "available", value: diagnostics.review }
      : { availability: "unavailable", reason: "review has no structural data" },
  };
  if (diagnostics.antiPatterns.state === "available") {
    const report = diagnostics.antiPatterns.value;
    return {
      scope, facts: { ...facts, "anti-patterns": { availability: "available", value: report } }, signals: [],
      findings: report.hits.map((hit) => ({ id: ["anti-pattern", hit.source, hit.ruleId, hit.file].join(":"), assetId: hit.source, domains: ["anti-patterns"], factIds: ["anti-patterns.v1"], confidence: "medium" })),
    };
  }
  return {
    scope, facts: { ...facts, "anti-patterns": { availability: "unavailable", reason: diagnostics.antiPatterns.reason } }, findings: [],
    signals: [{ id: "ANTI_PATTERN_COLLECTION", state: "unavailable", domains: ["anti-patterns"], factIds: ["anti-patterns.v1"], message: diagnostics.antiPatterns.reason }],
  };
};
