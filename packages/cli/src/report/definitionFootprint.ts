// 定义面信号（report-only，校准 2026-08-08）：声明密集且规模大的生产文件。
// 双语言级 P95（零硬编码）：decl > 本语言 decl P95 且 loc > 本语言 loc P95。
// 小文件声明占比高是正常形态，语言规模差异由语言级 P95 消化。
import { message, type Locale } from "../i18n";

interface DefinitionMetric {
  readonly path: string;
  readonly language?: string;
  readonly declarationLoc?: number;
  readonly loc?: number;
}

/** 语言级 decl/loc P95 阈值（纯函数）。declP95=0 的语言无声明密集型。 */
export const languageDefinitionThresholds = (metrics: readonly DefinitionMetric[]): ReadonlyMap<string, { declP95: number; locP95: number }> => {
  const byLang = new Map<string, { decl: number; loc: number }[]>();
  for (const metric of metrics) {
    const language = metric.language ?? "unknown";
    if (!byLang.has(language)) byLang.set(language, []);
    byLang.get(language)!.push({ decl: metric.declarationLoc ?? 0, loc: metric.loc ?? 0 });
  }
  const p95of = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  };
  const thresholds = new Map<string, { declP95: number; locP95: number }>();
  for (const [language, rows] of byLang) {
    const declP95 = p95of(rows.map((r) => r.decl));
    thresholds.set(language, { declP95, locP95: p95of(rows.map((r) => r.loc)) });
  }
  return thresholds;
};

export const definitionFootprintLines = (locale: Locale, metrics: readonly DefinitionMetric[]): readonly string[] => {
  const thresholds = languageDefinitionThresholds(metrics);
  const heavy = metrics
    .filter((metric) => {
      const lang = thresholds.get(metric.language ?? "unknown");
      if (!lang || lang.declP95 === 0) return false;
      return (metric.declarationLoc ?? 0) > lang.declP95 && (metric.loc ?? 0) > lang.locP95;
    })
    .sort((left, right) => (right.declarationLoc ?? 0) - (left.declarationLoc ?? 0));
  if (heavy.length === 0) return [];
  return [
    message(locale, "governance.definitionHeading"),
    ...heavy.map((metric) => message(locale, "governance.definitionEntry", { path: metric.path, decl: metric.declarationLoc ?? 0, loc: metric.loc ?? 0 })),
  ];
};
