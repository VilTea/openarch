import type { FactResultLike, Finding, GovernanceAvailability, PolicyProjection, Signal } from "../../domain/governance";
import type { TestFinding } from "../../domain/testGovernance";
import type { DiagnosticPart } from "./governanceDiagnostics";
import type { TestGovernanceReport } from "../testGovernance";

export interface TestProjection {
  /** 域 → 类型化载荷（test-governance 槽位）。 */
  readonly facts: Readonly<Record<string, FactResultLike<unknown>>>;
  readonly findings: readonly Finding[];
  readonly signals: readonly Signal[];
  readonly policyProjections: readonly PolicyProjection[];
}

const coverageAvailability = (status: string): GovernanceAvailability =>
  status === "available" ? "available" : status === "partial" ? "partial" : "unavailable";

const findingId = (finding: TestFinding): string =>
  ["test", finding.source, finding.ruleId, finding.file, finding.testName ?? "", String(finding.line ?? "")].join(":");

const confidence = (value: TestFinding["confidence"]): Finding["confidence"] => value === "confirmed" ? "high" : value;

/** Test provider facts and explicit finding policy stay together, while coverage remains a signal. */
export const projectTestGovernance = (tests: DiagnosticPart<TestGovernanceReport>): TestProjection => {
  if (tests.state === "unavailable") {
    return {
      facts: { "test-governance": { availability: "unavailable", reason: tests.reason } }, findings: [], policyProjections: [],
      signals: [{ id: "TEST_GOVERNANCE_COLLECTION", state: "unavailable", domains: ["test-governance"], factIds: ["test-governance.v1"], message: tests.reason }],
    };
  }
  const report = tests.value;
  const availability = coverageAvailability(report.collection.coverage.status);
  const reason = report.collection.coverage.reasons.join(", ") || `coverage is ${report.collection.coverage.status}`;
  return {
    facts: { "test-governance": availability === "available" ? { availability, value: report } : availability === "partial" ? { availability, value: report, reason } : { availability, reason } },
    findings: report.decision.findings.map((finding) => ({ id: findingId(finding), assetId: finding.source, domains: ["test-governance"], factIds: ["test-governance.v1"], confidence: confidence(finding.confidence) })),
    policyProjections: report.decision.triggered.map(({ finding, level }) => ({ policyId: `test-governance:${finding.kind}`, subject: { kind: "finding", findingId: findingId(finding) }, action: level })),
    signals: availability === "available" ? [] : [{ id: "TEST_GOVERNANCE_COVERAGE", state: availability, domains: ["test-governance"], factIds: ["test-governance.v1"], message: reason }],
  };
};
