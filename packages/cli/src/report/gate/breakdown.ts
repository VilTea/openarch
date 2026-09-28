import { computeCRLStateBreakdown, maxFuncWeightedBranchOf, type GateAppOutput, type GateFileMetric } from "@openarch/core";
import { type Locale, message } from "../../i18n";
import { bar } from "./shared";

export const renderBreakdown = (locale: Locale, metric: GateFileMetric, p95: NonNullable<NonNullable<GateAppOutput["report"]>["p95"]>, weights: NonNullable<GateAppOutput["report"]>["weights"]): readonly string[] => {
  const breakdown = computeCRLStateBreakdown({ maxFuncBranch: maxFuncWeightedBranchOf(metric), nestingDepth: metric.nestingDepth, loc: metric.loc, declarationLoc: metric.declarationLoc, alphaStruct: metric.alphaStruct, connectedness: metric.connectedness, singleCallSiteRatio: metric.singleCallSiteRatio, externalPassthroughCalls: metric.externalPassthroughCalls, passthroughCalls: metric.passthroughCalls }, p95, weights);
  const external = metric.externalPassthroughCalls ?? 0;
  return [
    message(locale, "gate.breakdownSummary", { local: breakdown.localBurden.toFixed(3), exposure: breakdown.exposure.toFixed(3), shape: breakdown.moduleShape.toFixed(3), composite: breakdown.composite.toFixed(3) }),
    message(locale, "gate.breakdownP95", { branch: p95.branch.toFixed(1), nesting: p95.nesting.toFixed(1), loc: p95.loc.toFixed(1), alpha: p95.alpha.toFixed(2), connectedness: p95.oneMinusConnectedness.toFixed(3), external: p95.externalPassthrough.toFixed(1) }),
    message(locale, "gate.breakdownBranch", { bar: bar(breakdown.components.branch), value: breakdown.components.branch.toFixed(3) }),
    message(locale, "gate.breakdownNesting", { bar: bar(breakdown.components.nesting), value: breakdown.components.nesting.toFixed(3) }),
    message(locale, "gate.breakdownLoc", { bar: bar(breakdown.components.loc), value: breakdown.components.loc.toFixed(3) }),
    message(locale, "gate.breakdownExternal", { bar: bar(breakdown.components.externalPassthrough), value: breakdown.components.externalPassthrough.toFixed(3), external, p95: p95.externalPassthrough.toFixed(1), capped: external >= p95.externalPassthrough && p95.externalPassthrough > 0 ? message(locale, "gate.capped") : "" }),
    message(locale, "gate.breakdownReview", {
      alpha: breakdown.components.alpha.toFixed(3),
      disconnected: breakdown.components.disconnectedness.toFixed(3),
      // 伴读值：与"不连通"同行呈现，因为机械分解会同时表现为"图仍连通 + 单调用点占比升高"。
      singleCallSite: breakdown.singleCallSiteRatio === null
        ? message(locale, "gate.breakdownCallSiteUnavailable")
        : breakdown.singleCallSiteRatio.toFixed(3),
      // 概念数代理：本次复盘的实测证据（R2：总量 −32% 但函数数 7→19、声明行 15→39）表明
      // "每函数分支下降"可以被"概念数上升"换来。该值已在逐文件事实里持久化，同屏显示即可
      // 让读者当场分辨"真降复杂度"与"拆分达标"，不新增指标、不新增权重。
      declarationLoc: metric.declarationLoc === undefined
        ? message(locale, "gate.breakdownCallSiteUnavailable")
        : String(metric.declarationLoc),
    }),
  ];
};
