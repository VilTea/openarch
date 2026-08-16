import { type GateAppOutput } from "@openarch/core";
import { type Locale, message } from "../i18n";
import { renderStructuralSections } from "./gate/structure";
import { renderTriggers, renderUnavailable } from "./gate/triggers";

/** Public CLI entry point; sections own distinct evidence presentation. */
export const renderGateReport = (output: GateAppOutput, locale: Locale): readonly string[] => {
  if (!output.report) return renderUnavailable(locale, output);
  const triggered = output.report.result.triggered ?? [];
  // WARN 摘要内联在 Verdict 行——防止只 grep Verdict 行而漏看 WARN 明细
  // （校准 2026-08-07：提交时曾只取 Verdict 行无视 WARN）
  const verdict = output.report.result.verdict;
  const verdictText = verdict === "WARN" && triggered.length > 0
    ? `${verdict}${message(locale, "gate.verdictWarnSuffix", { count: triggered.length })}`
    : verdict;
  const lines = [
    message(locale, "gate.heading"),
    message(locale, "gate.verdict", { verdict: verdictText }),
    message(locale, "gate.evaluated", { files: output.report.metrics.length }),
    ...renderTriggers(locale, output),
  ];
  if (output.report.policies && output.report.policies.length > 0) {
    lines.push(message(locale, "gate.policiesHeading"));
    lines.push(...output.report.policies.map((policy) => message(locale, "gate.policy", {
      id: policy.id,
      mode: message(locale, `gate.policy.${policy.mode}`),
      languages: policy.languages.join(","),
      files: policy.evaluatedFiles,
    })));
  }
  if (output.smallSamplePolicies && output.smallSamplePolicies.length > 0) {
    lines.push(message(locale, "gate.smallSampleHeading"));
    lines.push(...output.smallSamplePolicies.map((policy) => message(locale, "gate.smallSamplePolicy", {
      id: policy.id, files: policy.files, calibration: message(locale, `gate.smallSample.${policy.calibration}`),
    })));
  }
  const calibrationShifts = output.calibrationShifts ?? [];
  if (calibrationShifts.length > 0) {
    lines.push(message(locale, "gate.calibrationHeading"));
    lines.push(...calibrationShifts.map((shift) => message(locale, "gate.calibrationShift", { path: shift.path, sealed: shift.gateLocalBurden.toFixed(3), observed: shift.observedLocalBurden.toFixed(3), previousRules: shift.gateRules.join(",") || message(locale, "gate.none"), observedRules: shift.observedRules.join(",") || message(locale, "gate.none") })));
  }
  if (output.configuredRules === 0) lines.push(message(locale, "gate.unconfigured"), message(locale, "gate.unconfiguredAction"));
  if (output.report.report) lines.push(...renderStructuralSections(locale, output), "", "---", message(locale, "gate.footer"));
  return lines;
};
