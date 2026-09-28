import { type GateAppOutput } from "@openarch/core";
import { type Locale, message } from "../../i18n";

/**
 * 阈值可见性（report-only，校准 2026-09-25）。
 *
 * 缺陷：项目把校准依据写成 config 注释（"设为 >6 容忍约 5%"），治理后指标与总体演进，
 * 注释不再成立，而 check/scan 都不提示，"阈值/P95 倍数"要靠人肉复算。
 * 这里把已声明阈值、当前 P95、倍数与超阈文件数并列出来；**只报告，不自动改配置**。
 * 没有 P95 口径的 gate 指标（复合值如 `crl_local`）只给超阈计数，不臆造倍数。
 */
export const renderThresholdVisibility = (locale: Locale, output: GateAppOutput): readonly string[] => {
  const facts = output.report?.thresholds ?? [];
  if (facts.length === 0) return [];
  const notApplicable = message(locale, "gate.thresholdNotApplicable");
  return [
    message(locale, "gate.thresholdHeading"),
    ...facts.map((fact) => message(locale, "gate.thresholdEntry", {
      policy: fact.policyId,
      rule: fact.rule,
      metric: fact.metricId,
      comparison: fact.comparison,
      threshold: String(fact.threshold),
      p95: fact.p95 === undefined ? notApplicable : fact.p95.toFixed(3),
      ratio: fact.ratio === undefined ? notApplicable : fact.ratio.toFixed(2),
      // D5：倍数漂移（封存 → 当前观察）。两侧任一缺失或非正时该槽位为空串，
      // 不打印半截信息，也不用 0 冒充。
      observed: fact.observedRatio === undefined
        ? ""
        : message(locale, "gate.thresholdObserved", { observed: fact.observedRatio.toFixed(2) }),
      over: String(fact.overThresholdFiles),
      files: String(fact.evaluatedFiles),
    })),
    message(locale, "gate.thresholdAction"),
    // 合取规则的读法（2026-09-27 复盘）：本表只列"单指标 + 阈值"，而真实规则可能是合取
    // （`crl_local > 0.45 && exposure > 0.6`）⇒ 必须写明"不再被点名 ≠ 每个分量都回到阈值内"。
    message(locale, "gate.thresholdConjunction"),
    // 饱和分量的读法：`externalPassthrough` 权重固定且按 P95 归一化封顶，已达 P95 时该维度
    // 再怎么降都不会改善这一线（行内已标 `已截断`，这里把它说成"没有余量"而不是"还不够好"）。
    message(locale, "gate.thresholdSaturation"),
  ];
};
