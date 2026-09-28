import { describe, expect, it } from "vitest";
import type { GateAppOutput } from "@openarch/core";
import { renderGateReport } from "../../src/report/gateReport";

const weights = { branch: 0.2, nesting: 0.2, loc: 0.15, alpha: 0.15, connectedness: 0.15, externalPassthrough: 0.15 };
const output = (overrides: Partial<GateAppOutput> = {}): GateAppOutput => ({
  code: 0, verdict: "PASS", configuredRules: 1, evaluatedFiles: 0,
  report: { result: { verdict: "PASS", triggered: [] }, metrics: [], report: true, p95: undefined, weights },
  ...overrides,
});

/** 一个由 enforce 总体产生的 WARN 触发：完整渲染块是本次修复的验收面。 */
const warnOutput = (): GateAppOutput => output({
  code: 1, verdict: "WARN", evaluatedFiles: 1,
  report: {
    result: {
      verdict: "WARN",
      triggered: [{
        name: "function complexity", level: "warn", condition: "max_func_branch > 5",
        file: "packages/core/src/domain/example.ts", observed: { max_func_branch: 7 }, mode: "enforce",
      }],
    },
    metrics: [{
      path: "packages/core/src/domain/example.ts", fileKind: "production", branchCount: 7,
      maxFuncBranch: 7, nestingDepth: 2, alphaStruct: 0, cohesion: 1,
    }],
    report: false, p95: undefined, weights,
  },
});

describe("gate report", () => {
  it("renders report-only structural facts in English without Chinese text", () => {
    const english = renderGateReport(output({ report: {
      result: { verdict: "WARN", triggered: [{ name: "top-level dispatch", level: "warn", condition: "top_level_branch > 8", file: "bin/openarch.js" }] },
      metrics: [{ path: "bin/openarch.js", fileKind: "production", branchCount: 3, weightedBranchTotal: 3, topLevelWeightedBranch: 3, maxFuncBranch: 0, nestingDepth: 1, alphaStruct: 0, cohesion: 1 }], report: true, p95: undefined, weights,
    } }), "en").join("\n");

    expect(english).toContain("Investigate alternatives to top-level dispatch");
    expect(english).toContain("Top-Level Control Flow (Report Only)");
    expect(english).toContain("bin/openarch.js");
    expect(english).toContain("3.0");
    expect(english).not.toContain("|------");
    expect(english).not.toMatch(/[\p{Script=Han}]/u);
  });

  it("renders declared thresholds next to the current P95 and the over-threshold count", () => {
    // 校准依据会随指标与总体演进过期（历史症状：注释写"设为 >6 容忍约 5%"，治理后只剩约 1%），
    // 报告必须同时给出阈值、当前 P95、倍数与超阈文件数。
    const text = renderGateReport(output({ report: {
      result: { verdict: "PASS", triggered: [] },
      metrics: [],
      report: true,
      p95: undefined,
      weights,
      thresholds: [
        { policyId: "java-application", rule: "函数分支过多", metricId: "max_func_branch", comparison: ">", threshold: 6, p95: 4.415, ratio: 6 / 4.415, overThresholdFiles: 3, evaluatedFiles: 458 },
        { policyId: "java-application", rule: "局部负担过高", metricId: "crl_local", comparison: ">", threshold: 0.5, overThresholdFiles: 1, evaluatedFiles: 458 },
      ],
    } }), "zh").join("\n");
    expect(text).toContain("### 阈值与当前 P95（仅报告）");
    expect(text).toContain("java-application/函数分支过多: max_func_branch > 6；当前 P95=4.415；倍数=1.36；超阈文件 3/458");
    // 复合指标没有 P95 口径 ⇒ 只给超阈计数，不臆造倍数。
    expect(text).toContain("crl_local > 0.5；当前 P95=不适用（该指标无 P95 口径）；倍数=不适用（该指标无 P95 口径）；超阈文件 1/458");
    expect(text).toContain("不要自动修改阈值");
  });

  it("omits the threshold section when no threshold facts exist", () => {
    const text = renderGateReport(output(), "zh").join("\n");
    expect(text).not.toContain("阈值与当前 P95");
  });

  it("renders the max-branch owner and its shape split next to the trigger", () => {
    // 校准 2026-09-25：只给文件路径会让 Agent 盲拆（历史上拆错两轮）。
    // 归属与形态必须随触发项一起出现，且与加权值可复算。
    const zh = renderGateReport(output({ report: {
      result: {
        verdict: "WARN",
        triggered: [{
          name: "function complexity", level: "warn", condition: "max_func_branch > 5",
          file: "src/domain/example.ts", observed: { max_func_branch: 7 }, mode: "enforce",
        }],
      },
      metrics: [{
        path: "src/domain/example.ts", fileKind: "production", branchCount: 7, maxFuncBranch: 7,
        nestingDepth: 2, alphaStruct: 0, cohesion: 1,
        maxFuncBranchOwner: { name: "fold", line: 42, weighted: 7, ordinaryIf: 4, guardIf: 6, caseCount: 4 },
      }],
      report: false, p95: undefined, weights,
    } }), "zh").join("\n");
    expect(zh).toContain("归属: fold L42；加权=7.000（普通 if 4 / 卫语句 6 / case 4）");
    // 形态分解可复算加权值：4×1.0 + (6+4)×0.3 = 7.0
    expect(4 * 1.0 + (6 + 4) * 0.3).toBeCloseTo(7, 5);

    const en = renderGateReport(output({ report: {
      result: {
        verdict: "WARN",
        triggered: [{ name: "function complexity", level: "warn", condition: "max_func_branch > 5", file: "a.ts", mode: "enforce" }],
      },
      metrics: [{ path: "a.ts", fileKind: "production", branchCount: 2, maxFuncBranch: 2, nestingDepth: 1, alphaStruct: 0, maxFuncBranchOwner: { name: "g", weighted: 2, ordinaryIf: 2, guardIf: 0, caseCount: 0 } }],
      report: false, p95: undefined, weights,
    } }), "en").join("\n");
    // 行号缺失时不得编造 L0；只给名称。
    expect(en).toContain("Owner: g; weighted=2.000 (ordinary if 2 / guard 0 / case 0)");
    expect(en).not.toContain("L0");
  });

  it("does not render an owner line for conditions that do not read max_func_branch", () => {
    const text = renderGateReport(output({ report: {
      result: { verdict: "WARN", triggered: [{ name: "local burden", level: "warn", condition: "crl_local > 0.5", file: "a.ts" }] },
      metrics: [{ path: "a.ts", fileKind: "production", branchCount: 2, maxFuncBranch: 2, nestingDepth: 1, alphaStruct: 0, maxFuncBranchOwner: { name: "g", weighted: 2, ordinaryIf: 2, guardIf: 0, caseCount: 0 } }],
      report: false, p95: undefined, weights,
    } }), "en").join("\n");
    expect(text).not.toContain("Owner:");
  });

  it("renders burden evidence and unavailable facts through the requested locale", () => {
    const report = renderGateReport(output({ report: {
      result: { verdict: "WARN", triggered: [{ name: "local burden", level: "warn", condition: "crl_local > 0.3", file: "adapter.ts" }] },
      metrics: [{ path: "adapter.ts", fileKind: "production", branchCount: 0, nestingDepth: 0, alphaStruct: 0, cohesion: 1, externalPassthroughCalls: 12 }], report: false,
      p95: { branch: 10, nesting: 10, loc: 10, alpha: 1, oneMinusConnectedness: 1, externalPassthrough: 10 }, weights,
    } }), "zh").join("\n");
    expect(report).toContain("直接非本地=12 / P95=10.0，已截断");

    const unavailable = renderGateReport({ code: 3, verdict: "UNAVAILABLE", unavailableReason: "missing_baseline_index" }, "en").join("\n");
    expect(unavailable).toContain("no readable baseline index");
    expect(unavailable).not.toMatch(/[\p{Script=Han}]/u);
  });

  // 验收：WARN 渲染块逐行冻结——条件、文件、mode 标注、调查方向，
  // 以及“WARN 不是整改指令”的单一权威陈述。
  it("renders the complete WARN block in English, including mode and the WARN-not-a-mandate advisory", () => {
    expect(renderGateReport(warnOutput(), "en")).toEqual([
      "## Check Policy Verdict",
      "- Verdict: WARN (1 WARNs, see above)",
      "- A WARN is not a mandate: investigate the triggering facts first, then the project owner decides - fix, accept with a recorded decision, or recalibrate through an audited config change. Never loosen rules or delete evidence to pass a check.",
      "- Production files evaluated: 1",
      "  [WARN][enforce] function complexity: max_func_branch > 5 (observed max_func_branch=7.000)",
      "    -> packages/core/src/domain/example.ts",
      "    -> Investigation direction: Investigate why branches concentrate in this function: too many responsibilities, or a strategy or lookup table fits better.",
    ]);
  });

  it("renders the complete WARN block in Chinese through the same single render chain", () => {
    expect(renderGateReport(warnOutput(), "zh")).toEqual([
      "## check 策略裁决",
      "- Verdict: WARN（1 项 WARN，见上）",
      "- WARN 不是必须执行的整改指令：先调查触发事实，再由项目所有者决定——修复、记录接受决定，或经配置审计重新校准。不得为通过检查而放宽规则或删除证据。",
      "- 评估文件数: 1",
      "  [WARN][强制] function complexity: max_func_branch > 5（实际 max_func_branch=7.000）",
      "    → packages/core/src/domain/example.ts",
      "    → 调查方向: 先查该函数的分支为何集中：是职责过多，还是策略/查找表更合适。",
    ]);
  });

  // 观察总体不产出裁决，也不得给出整改指向：enforce 触发与 observe 候选项必须一眼可分。
  it("labels an observe-only candidate and offers no investigation direction for it", () => {
    const observeOnly = renderGateReport(output({ report: {
      result: { verdict: "WARN", triggered: [{ name: "python trial", level: "warn", condition: "max_func_branch > 5", mode: "observe" }] },
      metrics: [], report: false, p95: undefined, weights,
    } }), "en").join("\n");

    expect(observeOnly).toContain("[WARN][observe (no verdict)] python trial: max_func_branch > 5");
    expect(observeOnly).not.toContain("Investigation direction");
  });
});
