import { Effect } from "effect";
import { type FactSnapshot, type Finding, type GovernanceFact, type PolicyProjection, type Signal } from "../../domain/governance";
import { projectGovernanceFacts } from "./governanceFactProjection";
import { governanceDiagnostics, type GovernanceDiagnosticsReport } from "./governanceDiagnostics";
import { projectTestGovernance } from "./testGovernanceProjection";

export interface GovernanceEvaluation {
  readonly snapshot: FactSnapshot;
  readonly findings: readonly Finding[];
  /** Signals remain diagnostic-only and never become policy projections. */
  readonly signals: readonly Signal[];
  readonly policyProjections: readonly PolicyProjection[];
  readonly diagnostics: GovernanceDiagnosticsReport;
}

export const assembleGovernanceEvaluation = (diagnostics: GovernanceDiagnosticsReport): GovernanceEvaluation => {
  const facts = projectGovernanceFacts(diagnostics);
  const tests = projectTestGovernance(diagnostics.tests);
  const signals: Signal[] = [...facts.signals, ...tests.signals];
  if (diagnostics.gate.verdict === "UNAVAILABLE") {
    const diagnostic = diagnostics.gate.diagnostic;
    signals.push({ id: "ARCHITECTURE_POLICY_COLLECTION", state: "unavailable", domains: ["architecture-policy"], factIds: ["architecture-policy.v1"], message: diagnostic ? `${diagnostic.category}/${diagnostic.operation}: ${diagnostic.message}` : "gate policy evidence is unavailable" });
  }
  for (const shift of diagnostics.gate.calibrationShifts ?? []) {
    signals.push({ id: `CALIBRATION_SHIFT:${shift.path}`, state: "observed", domains: ["architecture-policy"], factIds: ["architecture-policy.v1"], message: `sealed local burden ${shift.gateLocalBurden.toFixed(3)} -> observed ${shift.observedLocalBurden.toFixed(3)}; policy ${shift.gateRules.join(",") || "none"} -> ${shift.observedRules.join(",") || "none"}` });
  }
  if (!diagnostics.review.hasData) {
    signals.push({ id: "STRUCTURE_REVIEW_COLLECTION", state: "unavailable", domains: ["structure-review"], factIds: ["structure-review.v1"], message: "review has no structural data" });
  }
  return {
    snapshot: { scope: facts.scope, facts: { ...facts.facts, ...tests.facts } },
    findings: [...facts.findings, ...tests.findings], signals, policyProjections: tests.policyProjections, diagnostics,
  };
};

/** Read-only Effect workflow. Existing collection use cases remain fact sources during migration. */
export const evaluateGovernance = () => governanceDiagnostics().pipe(Effect.map(assembleGovernanceEvaluation));
