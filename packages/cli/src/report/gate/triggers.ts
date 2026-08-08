import { type GateAppOutput } from "@openarch/core";
import { type Locale, message } from "../../i18n";
import { renderBreakdown } from "./breakdown";
import { hasBurdenMetric, recommendations } from "./shared";

export const renderUnavailable = (locale: Locale, output: GateAppOutput): readonly string[] => [
  message(locale, "gate.heading"), message(locale, "gate.verdict", { verdict: "UNAVAILABLE" }),
  message(locale, `gate.unavailable.${output.unavailableReason ?? "execution_failed"}`),
  ...(output.diagnostic ? [message(locale, "gate.diagnostic", { category: output.diagnostic.category, operation: output.diagnostic.operation, path: output.diagnostic.path ? ` (${output.diagnostic.path})` : "", detail: output.diagnostic.message })] : []),
  message(locale, "gate.unavailableAction"),
];

export const renderTriggers = (locale: Locale, output: GateAppOutput): readonly string[] => {
  if (!output.report) return [];
  const { result, metrics, p95, weights } = output.report;
  const lines: string[] = [];
  for (const trigger of result.triggered) {
    // 数值内联（校准 2026-08-08）：条件变量实际值直接显示，不只看规则名。
    const obs = trigger.observed;
    const conditionValues = obs ? (trigger.condition.match(/\b[a-z_][a-z0-9_]*\b/g) ?? []).filter((name) => typeof obs[name] === "number").map((name) => `${name}=${(obs[name] as number).toFixed(3)}`).join(" ") : "";
    lines.push(message(locale, "gate.trigger", { level: trigger.level.toUpperCase(), name: trigger.name, condition: trigger.condition, observed: conditionValues ? `（实际 ${conditionValues}）` : "" }));
    if (trigger.file) lines.push(message(locale, "gate.triggerFile", { path: trigger.file }));
    lines.push(...recommendations(locale, trigger.condition).map((recommendation) => message(locale, "gate.recommendation", { recommendation })));
    // 因子分解（复用 renderBreakdown）：report.p95 可能 undefined（多 policy），
    // 用 per-file observed.p95 兜底——同一文件触发项显示完整贡献分解。
    const p95v = p95 ?? (trigger.observed?.p95 as NonNullable<GateAppOutput["report"]>["p95"] | undefined);
    if (p95v && trigger.file && hasBurdenMetric(trigger.condition)) {
      const metric = metrics.find((entry) => entry.path === trigger.file);
      if (metric) lines.push(...renderBreakdown(locale, metric, p95v, weights));
    }
  }
  return lines;
};
