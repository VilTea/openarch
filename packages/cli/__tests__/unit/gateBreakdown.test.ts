import { describe, expect, it } from "vitest";
import { renderBreakdown } from "../../src/report/gate/breakdown";
import { DEFAULT_CRL_STATE_WEIGHTS, type GateFileMetric, type P95Values } from "@openarch/core";

const p95: P95Values = {
  branch: 10, nesting: 10, loc: 10, alpha: 1, oneMinusConnectedness: 0.5, externalPassthrough: 10,
};

const metric = (extra: Partial<GateFileMetric>): GateFileMetric => ({
  path: "src/a.ts", fileKind: "production", branchCount: 1, nestingDepth: 1, alphaStruct: 0, ...extra,
});

/**
 * 单调用点助手占比**骑在既有的 review 行上**，不新开小节、不新增权重（校准 2026-09-25）。
 * 它与"不连通"同行渲染，因为机械分解的形态正是"图仍连通 + 单调用点占比升高"。
 */
describe("gate breakdown：形态伴读值", () => {
  it("与不连通形态同行渲染", () => {
    const lines = renderBreakdown("zh", metric({ connectedness: 0.88, singleCallSiteRatio: 0.81 }), p95, DEFAULT_CRL_STATE_WEIGHTS);
    const review = lines.find((line) => line.includes("review-only 枢纽位"));
    expect(review).toBeDefined();
    expect(review).toContain("不连通: ");
    expect(review).toContain("单调用点助手占比: 0.810");
  });

  it("没有该事实（旧基线）时显示不可判定，而不是 0.000", () => {
    const lines = renderBreakdown("zh", metric({ connectedness: 0.88 }), p95, DEFAULT_CRL_STATE_WEIGHTS);
    const review = lines.find((line) => line.includes("review-only 枢纽位"));
    expect(review).toContain("单调用点助手占比: 不可判定（文件内无调用点或旧基线无此事实）");
    expect(review).not.toContain("单调用点助手占比: 0.000");
  });

  it("英文报告不得混出汉字", () => {
    const lines = renderBreakdown("en", metric({ connectedness: 0.88, singleCallSiteRatio: 0.5 }), p95, DEFAULT_CRL_STATE_WEIGHTS);
    expect(lines.join("\n")).not.toMatch(/[\p{Script=Han}]/u);
  });
});
