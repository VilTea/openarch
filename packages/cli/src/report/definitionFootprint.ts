// 定义面信号（report-only，校准 2026-08-08）：声明密集且规模大的生产文件。
// 双语言级 P95（零硬编码）：decl > 本语言 decl P95 且 loc > 本语言 loc P95。
// 阈值计算与事实层共用 core 的 definitionSurfaceCandidates，避免双写。
import { definitionSurfaceCandidateMetrics } from "@openarch/core";
import { message, type Locale } from "../i18n";

export const definitionFootprintLines = (locale: Locale, metrics: readonly { path: string; language?: string; declarationLoc?: number; loc?: number }[]): readonly string[] => {
  const heavy = definitionSurfaceCandidateMetrics(metrics);
  if (heavy.length === 0) return [];
  return [
    message(locale, "governance.definitionHeading"),
    ...heavy.map((metric) => message(locale, "governance.definitionEntry", { path: metric.path, decl: metric.declarationLoc ?? 0, loc: metric.loc ?? 0 })),
  ];
};
