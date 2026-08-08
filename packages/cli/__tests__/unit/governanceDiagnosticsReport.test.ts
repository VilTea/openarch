import { describe, expect, it } from "vitest";
import { assembleGovernanceEvaluation } from "@openarch/core";
import { renderGovernanceDiagnostics } from "../../src/report/governanceDiagnosticsReport";

describe("governance diagnostics report", () => {
  it("separates metric policy, finding policy, and signals", () => {
    const lines = renderGovernanceDiagnostics(assembleGovernanceEvaluation({
      gate: { code: 0, verdict: "PASS", lines: [], configuredRules: 0, evaluatedFiles: 2 },
      review: {
        nFiles: 2, hasData: true, entries: [],
        p95: { branch: 4.4, nesting: 6, loc: 176.8, alpha: 0.7, oneMinusConnectedness: 0.6, externalPassthrough: 6.6 },
        top3: [{ path: "src/loop.ts", localBurden: 0.7, exposure: 0.3, moduleShape: 0.5, crl: 0, crlState: 0.7, alphaStruct: 0.3, branchCount: 9, weightedBranchTotal: 9, maxFuncBranch: 8, topLevelWeightedBranch: 0 }],
      },
      antiPatterns: { state: "available", value: { rulesRun: 1, hits: [{ ruleId: "empty-catch", file: "src/main.ts", message: "empty", source: "rule.mjs", scope: "file" }], errors: [], unavailable: [], sourcesRun: [], ruleFailures: [], pruning: [] } },
      tests: { state: "available", value: { decision: { verdict: "PASS", findings: [], triggered: [], exempted: [], errors: [] }, collection: { coverage: { status: "unavailable", reasons: ["no_active_provider"], testFiles: 1, unbaselinedTestFiles: [], providerHandledTestFiles: [], unrecognizedTestFiles: ["tests/a.ts"], failedTestFiles: [] }, testFiles: 1, providersRun: [], providerCoverage: [], providerSummaries: [], testCaseSpans: { availability: "unavailable" }, staticModuleAssociations: [], associationUnavailableTestFiles: [], unrecognizedTestFiles: ["tests/a.ts"] }, execution: { runnersRun: [], executions: [] }, scripts: { scriptUnavailable: [], scriptPruning: [] } } },
    })).join("\n");

    expect(lines).toContain("### 指标策略");
    expect(lines).toContain("### Finding 策略");
    expect(lines).toContain("### 信号");
    expect(lines).toContain("⚠ 治理信号 1 个（[UNAVAILABLE] TEST_GOVERNANCE_COVERAGE）——见下；PARTIAL/UNAVAILABLE 是事实边界，不是 clean。");
    expect(lines).toContain("[ATTENTION] 当前门禁未声明生产规则");
    expect(lines).toContain("### 探索性策略校准（仅建议）");
    expect(lines).toContain("max_func_branch P95=4.40");
    expect(lines).toContain("首轮不自动 BLOCK");
    expect(lines).toContain("结构候选仅解释指标策略");
    expect(lines).toContain("Finding: 1 (empty-catch=1)");
    expect(lines).toContain("[UNAVAILABLE] TEST_GOVERNANCE_COVERAGE");
    expect(lines).not.toContain("diff 和 gate");
  });

  it("renders architecture-gate triggered details when verdict is not PASS", () => {
    const lines = renderGovernanceDiagnostics(assembleGovernanceEvaluation({
      gate: {
        code: 1, verdict: "WARN", lines: [], configuredRules: 2, evaluatedFiles: 3,
        report: {
          result: {
            verdict: "WARN",
            triggered: [
              { name: "Go 函数局部复杂度试行 WARN", level: "warn", condition: "max_func_branch > 5", file: "services/x/task.go" },
              { name: "domain 局部负担过高", level: "warn", condition: "path_class == \"domain\" && crl_local > 0.55", file: "packages/core/src/domain/y.ts" },
            ],
          },
          metrics: [], report: true, p95: undefined, weights: { branch: 0.2, nesting: 0.2, loc: 0.15, alpha: 0.15, connectedness: 0.15, externalPassthrough: 0.15 },
        },
      },
      review: { nFiles: 0, hasData: false, entries: [], p95: undefined, top3: [] },
      antiPatterns: { state: "available", value: { rulesRun: 0, hits: [], errors: [], unavailable: [], sourcesRun: [], ruleFailures: [], pruning: [] } },
      tests: { state: "unavailable", reason: "no provider" },
    })).join("\n");

    expect(lines).toContain("架构门禁: WARN");
    expect(lines).toContain("[WARN] Go 函数局部复杂度试行 WARN: max_func_branch > 5 → services/x/task.go");
    expect(lines).toContain("[WARN] domain 局部负担过高: path_class == \"domain\" && crl_local > 0.55 → packages/core/src/domain/y.ts");
  });

  it("renders definition-footprint signal with language-level P95 threshold", () => {
    // 21 个 TS 文件：P95 = 第 20 个（decl=200），decl=210 触发（> P95），其余不触发
    const metrics = Array.from({ length: 21 }, (_, i) => ({
      path: `src/mod${i}.ts`, language: "typescript", branchCount: 1, nestingDepth: 2, alphaStruct: 0, cohesion: 1,
      loc: 200 + i, declarationLoc: 10 + (i + 1) * 10,
    }));
    const lines = renderGovernanceDiagnostics(assembleGovernanceEvaluation({
      gate: { code: 0, verdict: "PASS", lines: [], configuredRules: 1, evaluatedFiles: 21, report: { metrics, result: { verdict: "PASS", triggered: [] }, report: false } } as never,
      review: { nFiles: 0, hasData: false, entries: [], p95: undefined, top3: [] },
      antiPatterns: { state: "available", value: { rulesRun: 0, hits: [], errors: [], unavailable: [], sourcesRun: [], ruleFailures: [], pruning: [] } },
      tests: { state: "unavailable", reason: "no provider" },
    })).join("\n");

    expect(lines).toContain("定义面信号");
    expect(lines).toContain("src/mod20.ts"); // decl=210 > P95(200)
    expect(lines).not.toContain("src/mod18.ts"); // decl=190 <= P95
  });

  it("renders presentation through the requested locale", () => {
    const evaluation = assembleGovernanceEvaluation({
      gate: { code: 0, verdict: "PASS", lines: [], configuredRules: 1, evaluatedFiles: 2 },
      review: { nFiles: 0, hasData: false, entries: [], p95: undefined, top3: [] },
      antiPatterns: { state: "available", value: { rulesRun: 0, hits: [], errors: [], unavailable: [], sourcesRun: [], ruleFailures: [], pruning: [] } },
      tests: { state: "unavailable", reason: "no provider" },
    });

    const english = renderGovernanceDiagnostics(evaluation, "en").join("\n");
    expect(english).toContain("## Governance Review (Report Only)");
    expect(english).toContain("### Metric Policy");
    expect(english).toContain("Test governance: no provider");
    expect(english).not.toMatch(/[\p{Script=Han}]/u);
  });
});
