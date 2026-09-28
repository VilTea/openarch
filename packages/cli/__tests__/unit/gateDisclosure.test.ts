import { describe, expect, it } from "vitest";
import type { GateAppOutput, GateFileMetric, P95Values } from "@openarch/core";
import { DEFAULT_CRL_STATE_WEIGHTS } from "@openarch/core";
import { renderBreakdown } from "../../src/report/gate/breakdown";
import { renderThresholdVisibility } from "../../src/report/gate/calibration";

/**
 * 认知点/指标复盘（2026-09-27）带来的两处**报告面**披露，都是零新字段：
 *
 * 1. `声明行(概念数代理)` 与"单调用点助手占比"同行：实测证据是 R2 的重构把文件总量降了 32%，
 *    但函数数 7→19、声明行 15→39 —— "每函数分支下降"可以被"概念数上升"换来，两者必须并读。
 * 2. 阈值表的收尾说明必须写出**合取语义**（不再被点名 ≠ 每个分量都回到阈值内）与**饱和语义**
 *    （外部透传已达 P95 时继续降它不会改善这一线）。
 */
const p95: P95Values = {
  branch: 10, nesting: 10, loc: 10, alpha: 1, oneMinusConnectedness: 0.5, externalPassthrough: 36.1,
};

const metric = (extra: Partial<GateFileMetric>): GateFileMetric => ({
  path: "src/a.ts", fileKind: "production", branchCount: 1, nestingDepth: 1, alphaStruct: 0, ...extra,
});

const thresholdOutput = (observedRatio?: number): GateAppOutput => ({
  report: {
    thresholds: [{
      policyId: "typescript-js", rule: "domain single-function branch count", metricId: "max_func_branch", comparison: ">",
      threshold: 5, p95: 6.045, ratio: 0.83, ...(observedRatio === undefined ? {} : { observedRatio }),
      overThresholdFiles: 1, evaluatedFiles: 362,
    }],
  },
} as unknown as GateAppOutput);

describe("概念数代理与阈值表口径披露（report-only，零新字段）", () => {
  it("声明行与单调用点助手占比同屏，且不可判定时不写 0", () => {
    const withValue = renderBreakdown("zh", metric({ connectedness: 0.88, singleCallSiteRatio: 0.81, declarationLoc: 34 }), p95, DEFAULT_CRL_STATE_WEIGHTS);
    const review = withValue.find((line) => line.includes("review-only 枢纽位"));
    expect(review).toContain("单调用点助手占比: 0.810");
    expect(review).toContain("声明行(概念数代理): 34");

    const withoutValue = renderBreakdown("zh", metric({ connectedness: 0.88 }), p95, DEFAULT_CRL_STATE_WEIGHTS);
    const reviewWithout = withoutValue.find((line) => line.includes("review-only 枢纽位"));
    expect(reviewWithout).toContain("声明行(概念数代理): 不可判定（文件内无调用点或旧基线无此事实）");
    expect(reviewWithout).not.toContain("声明行(概念数代理): 0");
  });

  it("阈值表收尾写明合取语义与饱和语义", () => {
    const lines = renderThresholdVisibility("zh", thresholdOutput()).join("\n");
    expect(lines).toContain("合取");
    expect(lines).toContain("exposure");
    expect(lines).toContain("饱和");
    expect(lines).toContain("已截断");
  });

  it("D5：倍数是封存 P95 口径，另有当前观察倍数时并列打印（缺一则不打印）", () => {
    const withoutObserved = renderThresholdVisibility("zh", thresholdOutput()).join("\n");
    expect(withoutObserved).toContain("倍数=0.83");
    expect(withoutObserved).not.toContain("按当前观察 P95");

    const withObserved = renderThresholdVisibility("zh", thresholdOutput(0.62)).join("\n");
    expect(withObserved).toContain("倍数=0.83");
    expect(withObserved).toContain("按当前观察 P95=0.62");

    const english = renderThresholdVisibility("en", thresholdOutput(0.62)).join("\n");
    expect(english).toContain("by current observed P95=0.62");
    expect(english).not.toMatch(/[\p{Script=Han}]/u);
  });

  it("英文披露不得混出汉字", () => {
    const lines = [
      ...renderBreakdown("en", metric({ connectedness: 0.88, singleCallSiteRatio: 0.5, declarationLoc: 34 }), p95, DEFAULT_CRL_STATE_WEIGHTS),
      ...renderThresholdVisibility("en", thresholdOutput()),
    ].join("\n");
    expect(lines).not.toMatch(/[\p{Script=Han}]/u);
  });
});
