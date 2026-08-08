import { describe, expect, it } from "vitest";
import type { GateAppOutput } from "@openarch/core";
import { renderGateReport } from "../../src/report/gateReport";

const weights = { branch: 0.2, nesting: 0.2, loc: 0.15, alpha: 0.15, connectedness: 0.15, externalPassthrough: 0.15 };
const output = (overrides: Partial<GateAppOutput> = {}): GateAppOutput => ({
  code: 0, verdict: "PASS", configuredRules: 1, evaluatedFiles: 0,
  report: { result: { verdict: "PASS", triggered: [] }, metrics: [], report: true, p95: undefined, weights },
  ...overrides,
});

describe("gate report", () => {
  it("renders report-only structural facts in English without Chinese text", () => {
    const english = renderGateReport(output({ report: {
      result: { verdict: "WARN", triggered: [{ name: "top-level dispatch", level: "warn", condition: "top_level_branch > 8", file: "bin/openarch.js" }] },
      metrics: [{ path: "bin/openarch.js", fileKind: "production", branchCount: 3, weightedBranchTotal: 3, topLevelWeightedBranch: 3, maxFuncBranch: 0, nestingDepth: 1, alphaStruct: 0, cohesion: 1 }], report: true, p95: undefined, weights,
    } }), "en").join("\n");

    expect(english).toContain("Replace top-level dispatch with a command registry");
    expect(english).toContain("Top-Level Control Flow (Report Only)");
    expect(english).toContain("bin/openarch.js");
    expect(english).toContain("3.0");
    expect(english).not.toContain("|------");
    expect(english).not.toMatch(/[\p{Script=Han}]/u);
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
});
