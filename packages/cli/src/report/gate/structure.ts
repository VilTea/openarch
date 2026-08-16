import { computeCRLStateBreakdown, maxFuncWeightedBranchOf, topLevelWeightedBranchOf, weightedBranchTotalOf, type GateAppOutput } from "@openarch/core";
import { type Locale, message } from "../../i18n";
import { renderAlignedTable } from "../table";

/** 结构负担 Top-3（数学美渲染，2026-08-08）：复用 renderAlignedTable 替代手写 markdown
 *  `| a | b |` 表格——CJK 感知对齐、数值右对齐，与 TEST_BLOAT/diff 报告同一渲染层。 */
export const renderStructuralSections = (locale: Locale, output: GateAppOutput): readonly string[] => {
  if (!output.report?.report) return [];
  const { metrics, p95, weights } = output.report;
  const lines: string[] = [];
  const top = p95 ? metrics.filter((metric) => metric.fileKind === "production")
    .map((metric) => ({ metric, breakdown: computeCRLStateBreakdown({ maxFuncBranch: maxFuncWeightedBranchOf(metric), nestingDepth: metric.nestingDepth, loc: metric.loc, declarationLoc: metric.declarationLoc, alphaStruct: metric.alphaStruct, connectedness: metric.connectedness, externalPassthroughCalls: metric.externalPassthroughCalls, passthroughCalls: metric.passthroughCalls }, p95, weights) }))
    .filter(({ breakdown }) => breakdown.localBurden > 0).sort((left, right) => right.breakdown.localBurden - left.breakdown.localBurden).slice(0, 3) : [];
  if (top.length > 0) {
    lines.push("", message(locale, "gate.topHeading"), "");
    lines.push(...renderAlignedTable(
      [
        { header: message(locale, "gate.topColFile") },
        { header: message(locale, "gate.topColLocal"), align: "right" },
        { header: message(locale, "gate.topColExposure"), align: "right" },
        { header: message(locale, "gate.topColShape"), align: "right" },
        { header: message(locale, "gate.topColComposite"), align: "right" },
      ],
      top.map(({ metric, breakdown }) => [metric.path, breakdown.localBurden.toFixed(3), breakdown.exposure.toFixed(3), breakdown.moduleShape.toFixed(3), breakdown.composite.toFixed(3)]),
      { indent: "  " },
    ));
  }
  const topLevel = metrics.filter((metric) => metric.fileKind === "production")
    .map((metric) => ({ metric, value: topLevelWeightedBranchOf(metric) }))
    .filter(({ value }) => value > 0).sort((left, right) => right.value - left.value).slice(0, 3);
  if (topLevel.length > 0) {
    lines.push("", message(locale, "gate.topLevelHeading"), "");
    lines.push(...renderAlignedTable(
      [
        { header: message(locale, "gate.topLevelColFile") },
        { header: message(locale, "gate.topLevelColWeighted"), align: "right" },
        { header: message(locale, "gate.topLevelColMaxFunc"), align: "right" },
        { header: message(locale, "gate.topLevelColTotal"), align: "right" },
      ],
      topLevel.map(({ metric, value }) => [metric.path, value.toFixed(1), maxFuncWeightedBranchOf(metric).toFixed(1), weightedBranchTotalOf(metric).toFixed(1)]),
      { indent: "  " },
    ));
  }
  return lines;
};
