import type { GovernanceEvaluation } from "@openarch/core";
import {
  definitionSurfaceCandidatePaths,
  definitionSurfaceSimilarityGroups,
} from "@openarch/core";
import { type Locale, message } from "../i18n";
import { definitionFootprintLines } from "./definitionFootprint";

const groupedHits = (locale: Locale, report: GovernanceEvaluation["diagnostics"]): readonly string[] => {
  if (report.antiPatterns.state === "unavailable") return [message(locale, "governance.antiPatternsUnavailable", { reason: report.antiPatterns.reason })];
  const { value } = report.antiPatterns;
  const groups = new Map<string, number>();
  for (const hit of value.hits) groups.set(hit.ruleId, (groups.get(hit.ruleId) ?? 0) + 1);
  const details = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, count]) => `${id}=${count}`);
  return [
    message(locale, "governance.rulesRun", { count: value.rulesRun }),
    message(locale, "governance.findings", { count: value.hits.length, details: details.length > 0 ? ` (${details.join(", ")})` : "" }),
    ...value.hits.map((hit) => {
      const location = hit.line === undefined ? hit.file : `${hit.file}:${hit.line}${hit.endLine && hit.endLine !== hit.line ? `-${hit.endLine}` : ""}`;
      return message(locale, "governance.findingDetail", { ruleId: hit.ruleId, location, message: hit.message });
    }),
    ...value.errors.map((error) => `- [RULE ERROR] ${error}`),
    ...value.unavailable.map((reason) => `- [UNAVAILABLE] ${reason}`),
  ];
};

const testPolicy = (locale: Locale, report: GovernanceEvaluation["diagnostics"]): readonly string[] => {  if (report.tests.state === "unavailable") return [message(locale, "governance.testsUnavailable", { reason: report.tests.reason })];
  const { value } = report.tests;
  return [
    message(locale, "governance.testCoverage", { status: value.collection.coverage.status.toUpperCase(), files: value.collection.testFiles, handled: value.collection.coverage.providerHandledTestFiles.length }),
    message(locale, "governance.testVerdict", { verdict: value.decision.verdict }),
    ...(value.collection.coverage.reasons.length > 0 ? [message(locale, "governance.coverageLimits", { reasons: value.collection.coverage.reasons.join(", ") })] : []),
  ];
};

const nextActions = (locale: Locale, evaluation: GovernanceEvaluation, hasDefinitionSurfaceCandidates: boolean): readonly string[] => {
  const report = evaluation.diagnostics;
  const actions: string[] = [];
  if (report.gate.configuredRules === 0) {
    actions.push(message(locale, "governance.actionConfigurePolicy"));
  }
  if (report.antiPatterns.state === "available" && report.antiPatterns.value.hits.length > 0) {
    actions.push(message(locale, "governance.actionAntiPatterns"));
  }
  if (evaluation.signals.some((signal) => signal.id === "TEST_GOVERNANCE_COVERAGE" || signal.id === "TEST_GOVERNANCE_COLLECTION")) {
    actions.push(message(locale, "governance.actionTestCoverage"));
  }
  if (hasDefinitionSurfaceCandidates) {
    actions.push(message(locale, "governance.actionDefinitionSurface"));
  }
  return actions.length > 0 ? actions : [message(locale, "governance.actionNone")];
};

const formatObservedP95 = (value: number | undefined): string =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "UNAVAILABLE";

/**
 * A missing policy is an opportunity to calibrate, not a reason to invent a
 * default. Reuse the observed P95 so the Agent can propose a project-owned
 * rule without turning this report into a second threshold authority.
 */
const exploratoryPolicyCalibration = (locale: Locale, evaluation: GovernanceEvaluation): readonly string[] => {
  if (evaluation.diagnostics.gate.configuredRules !== 0) return [];
  const p95 = evaluation.diagnostics.review.p95;
  return [
    message(locale, "governance.policyCalibrationHeading"),
    p95
      ? message(locale, "governance.policyCalibrationBaseline", {
        branch: formatObservedP95(p95.branch), nesting: formatObservedP95(p95.nesting),
        loc: formatObservedP95(p95.loc), external: formatObservedP95(p95.externalPassthrough),
      })
      : message(locale, "governance.policyCalibrationUnavailable"),
    message(locale, p95 ? "governance.policyCalibrationAction" : "governance.policyCalibrationWait"),
  ];
};

const renderDefinitionSurface = (locale: Locale, cwd: string | undefined, metrics: readonly { path: string; language?: string; declarationLoc?: number; loc?: number }[]): readonly string[] => {
  if (!cwd || metrics.length === 0) return [];
  const candidatePaths = definitionSurfaceCandidatePaths(metrics);
  const groups = definitionSurfaceSimilarityGroups(candidatePaths, { projectRoot: cwd });
  if (groups.length === 0) return [];
  const lines = [message(locale, "governance.definitionSurfaceHeading")];
  for (const group of groups) {
    lines.push(message(locale, "governance.definitionSurfaceGroup", {
      id: group.id, files: group.files.join(", "), lines: String(group.repeatedBlockLines), similarity: group.maxSimilarity.toFixed(2),
    }));
    for (const block of group.sampleBlocks) lines.push(message(locale, "governance.definitionSurfaceBlock", { file: block.file, line: String(block.startLine), text: block.text.split("\n")[0] ?? "" }));
  }
  return lines;
};

/** A compact, report-only governance review. Gate remains a separate policy verdict. */
export const renderGovernanceDiagnostics = (evaluation: GovernanceEvaluation, locale: Locale = "zh", cwd?: string): readonly string[] => {
  const report = evaluation.diagnostics;
  const lines = [
    message(locale, "governance.heading"),
    message(locale, "governance.metricPolicy"),
    message(locale, "governance.architectureGate", { verdict: report.gate.verdict, rules: report.gate.configuredRules ?? "UNAVAILABLE", files: report.gate.evaluatedFiles ?? "UNAVAILABLE" }),
  ];
  // 信号摘要内联在门禁裁决附近——防止只 grep Verdict 行而漏看治理信号
  // （校准 2026-08-08：曾长期忽略 TEST_GOVERNANCE_COVERAGE PARTIAL，直到 scan 才消除）
  if (evaluation.signals.length > 0) {
    lines.push(message(locale, "governance.signalSummary", {
      count: evaluation.signals.length,
      ids: evaluation.signals.map((signal) => `[${signal.state.toUpperCase()}] ${signal.id}`).join(", "),
    }));
  }
  if (report.gate.configuredRules === 0) lines.push(message(locale, "governance.unconfiguredGate"));
  const triggered = report.gate.report?.result.triggered ?? [];
  if (triggered.length > 0) {
    lines.push(...triggered.map((entry) =>
      message(locale, "governance.architectureTriggered", {
        level: entry.level.toUpperCase(), name: entry.name, condition: entry.condition, file: entry.file ?? "—",
      }),
    ));
  }
  lines.push(...exploratoryPolicyCalibration(locale, evaluation));

  lines.push(message(locale, "governance.structuralBoundary"));
  if (report.review.top3.length === 0) lines.push(message(locale, "governance.noStructuralData"));
  else lines.push(...report.review.top3.map((entry) =>
    message(locale, "governance.structuralEntry", { path: entry.path, local: entry.localBurden.toFixed(3), exposure: entry.exposure.toFixed(3), shape: entry.moduleShape.toFixed(3), crl: entry.crl.toFixed(1) }),
  ));
  const definitionSurfaceLines = renderDefinitionSurface(locale, cwd, report.gate.report?.metrics ?? []);
  lines.push(...definitionFootprintLines(locale, report.gate.report?.metrics ?? []));
  lines.push(...definitionSurfaceLines);

  lines.push(message(locale, "governance.findingPolicy"), message(locale, "governance.antiPatterns"), ...groupedHits(locale, report));
  lines.push(message(locale, "governance.testPolicy"), ...testPolicy(locale, report));
  lines.push(message(locale, "governance.signals"));
  if (evaluation.signals.length === 0) lines.push(message(locale, "governance.noSignals"));
  else lines.push(...evaluation.signals.map((signal) => `- [${signal.state.toUpperCase()}] ${signal.id}: ${signal.message}`));
  lines.push(message(locale, "governance.next"));
  lines.push(...nextActions(locale, evaluation, definitionSurfaceLines.length > 0).map((action, index) => `${index + 1}. ${action}`));
  return lines;
};
