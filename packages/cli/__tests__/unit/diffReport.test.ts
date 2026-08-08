import { describe, expect, it } from "vitest";
import { renderDiffReport } from "../../src/report/diffReport";

const detail = (beforeSource: "git" | "baseline" | "unavailable" = "git") => ({
  file: "src/a.ts", scope: beforeSource === "unavailable" ? "existing_unavailable" as const : "existing" as const, beforeSource,
  localBurden: { metrics: {
    branch: { before: beforeSource === "unavailable" ? null : 2, after: 2, delta: beforeSource === "unavailable" ? null : 0, normalizedDelta: beforeSource === "unavailable" ? null : 0 },
    nesting: { before: beforeSource === "unavailable" ? null : 1, after: 2, delta: beforeSource === "unavailable" ? null : 1, normalizedDelta: beforeSource === "unavailable" ? null : 0.02 },
    loc: { before: beforeSource === "unavailable" ? null : 10, after: 20, delta: beforeSource === "unavailable" ? null : 10, normalizedDelta: beforeSource === "unavailable" ? null : 0.02 },
    externalPassthrough: { before: beforeSource === "unavailable" ? null : 2, after: 1, delta: beforeSource === "unavailable" ? null : -1, normalizedDelta: beforeSource === "unavailable" ? null : -0.01 },
  }, deterioration: beforeSource === "unavailable" ? 0 : 0.04, improvement: beforeSource === "unavailable" ? 0 : 0.01 },
  exposure: { before: beforeSource === "unavailable" ? null : 0.2, after: 0.3, delta: beforeSource === "unavailable" ? null : 0.1 },
});

const report = (overrides: Partial<Parameters<typeof renderDiffReport>[0]> = {}) => ({
  summary: { iPush: 2.5, dMR: 0.04, deltas: [{ file: "src/a.ts", alphaStruct: 0.3, deltaI: 2.5 }], historyEntryId: "history-id", evidenceState: "sealed" as const },
  evidence: { mrDetail: [detail()], crl: new Map(), ...overrides.evidence },
  ...overrides,
});

describe("renderDiffReport", () => {
  it("keeps local deterioration, improvement, and exposure as separate facts", () => {
    const lines = renderDiffReport(report()).join("\n");
    expect(lines).toContain("嵌套 +1.0（加权归一化 +0.02）");
    expect(lines).toContain("外部编排 -1.0（加权归一化 -0.01）");
    expect(lines).toContain("局部恶化 +0.04，改善 -0.01；暴露 Δα=+0.100");
    expect(lines).toContain("文件级结构传播上界");
  });

  it("explains a zero D_MR as no local-burden deterioration", () => {
    expect(renderDiffReport(report({ summary: { iPush: 12, dMR: 0, deltas: [], historyEntryId: "history-id", evidenceState: "sealed" }, evidence: { mrDetail: [], crl: new Map() } })).join("\n")).toContain("无局部负担恶化（0.00，不参与 gate）");
  });

  it("shows pending evidence and a public-contract verification plan", () => {
    const lines = renderDiffReport(report({ summary: { iPush: 40, dMR: 0, deltas: [], historyEntryId: "pending-id", evidenceState: "pending" }, evidence: { mrDetail: [], crl: new Map(), impactPlan: [{ file: "src/api.ts", publicContracts: ["Api (interface_add_remove)"], implementationUnits: [], dependencyUnits: [], directConsumers: ["src/client.ts"], symbolConsumers: [], actions: [{ kind: "verify_direct_consumers", consumers: ["src/client.ts"] }] }] } })).join("\n");
    expect(lines).toContain("验证计划 src/api.ts: 公共合同 Api (interface_add_remove)");
    expect(lines).toContain("pending evidence: pending-id");
  });

  it("keeps explicitly requested semantic evidence visible", () => {
    const lines = renderDiffReport(report({ summary: { iPush: 40, dMR: 0, deltas: [], historyEntryId: "pending-id", evidenceState: "pending" }, evidence: { mrDetail: [], crl: new Map(), symbolUseReports: [{ origin: { language: "rust", providerId: "rust-analyzer-symbol-use", evidenceSource: "lsp" }, state: { availability: "partial", coverage: { declarations: "complete", repositoryReferences: "partial" }, reason: "Cargo workspace" }, facts: [] }] } })).join("\n");
    expect(lines).toContain("LSP rust-analyzer-symbol-use PARTIAL");
  });

  it("renders English without Chinese text", () => {
    const english = renderDiffReport(report({ summary: { iPush: 2, dMR: 0, deltas: [], historyEntryId: "pending-id", evidenceState: "pending" }, evidence: { mrDetail: [detail("unavailable")], crl: new Map(), impactPlan: [{ file: "src/api.ts", publicContracts: ["Api (interface_add_remove)"], implementationUnits: [], dependencyUnits: [], directConsumers: ["src/client.ts"], symbolConsumers: [], actions: [{ kind: "verify_direct_consumers", consumers: ["src/client.ts"] }] }] } }), "en").join("\n");
    expect(english).toContain("before structure is unavailable");
    expect(english).toContain("Verify direct consumers: src/client.ts");
    expect(english).not.toMatch(/[\p{Script=Han}]/u);
  });

  it("renders change-surface impact (C_push) with consumers and provenance", () => {
    const lines = renderDiffReport(report({
      summary: { iPush: 40, dMR: 0, deltas: [{ file: "src/api.ts", alphaStruct: 0.4, deltaI: 40 }], historyEntryId: "pending-id", evidenceState: "pending" },
      evidence: {
        mrDetail: [], crl: new Map(),
        changeSurfaces: {
          availability: "available",
          surfaces: [{
            file: "src/api.ts", language: "typescript",
            result: {
              provenance: "symbol",
              contributions: [
                { anchor: "Api.publish", kind: "public_method_sig", lambdaAst: 60, consumers: ["src/client.ts"], reachFactor: Math.log2(2), layerWeight: 2.0, contribution: 120 },
                { anchor: "compact", kind: "function_body", lambdaAst: 10, consumers: [], reachFactor: 0, layerWeight: 0, contribution: 0 },
              ],
              total: 120,
              consumersByAnchor: new Map([["Api.publish", ["src/client.ts"]], ["compact", []]]),
            },
          }],
          unavailableLanguages: [],
        },
      },
    })).join("\n");
    expect(lines).toContain("变更面冲击: C_push = Σ λ·log2(n+1)·ω = 120.0（symbol）");
    expect(lines).toContain("Api.publish (public_method_sig): λ=60 × log2(1+1)=1.000 × ω=2.00 → 120.0；消费者: src/client.ts");
    expect(lines).toContain("无仓库消费者");
    expect(lines).toContain("信号[symbol-heavy] src/api.ts: 变更面 C_push=120.0 大于文件冲击 I_push=40.0");
    // 数学美：per-file 对齐表格（file/lang/total/bound/confirmed）
    expect(lines).toMatch(/src\/api\.ts\s+typescript\s+120\.0/);
  });

  it("flags file-heavy false positives and renders English without Chinese text", () => {
    const english = renderDiffReport(report({
      summary: { iPush: 40, dMR: 0, deltas: [{ file: "src/hot.ts", alphaStruct: 0.4, deltaI: 40 }], historyEntryId: "pending-id", evidenceState: "pending" },
      evidence: {
        mrDetail: [], crl: new Map(),
        changeSurfaces: {
          availability: "available",
          surfaces: [{
            file: "src/hot.ts", language: "typescript",
            result: {
              provenance: "symbol",
              contributions: [{ anchor: "compact", kind: "function_body", lambdaAst: 10, consumers: ["src/one.ts"], reachFactor: Math.log2(2), layerWeight: 1.0, contribution: 10 }],
              total: 10,
              consumersByAnchor: new Map([["compact", ["src/one.ts"]]]),
            },
          }],
          unavailableLanguages: [],
        },
      },
    }), "en").join("\n");
    expect(english).toContain("signal[file-heavy] src/hot.ts");
    expect(english).toContain("C_push=10.0");
    expect(english).not.toMatch(/[\p{Script=Han}]/u);
  });

  it("renders unavailable languages without emitting any C_push value", () => {
    const lines = renderDiffReport(report({
      summary: { iPush: 40, dMR: 0, deltas: [{ file: "src/api.go", alphaStruct: 0.4, deltaI: 40 }], historyEntryId: "pending-id", evidenceState: "pending" },
      evidence: {
        mrDetail: [], crl: new Map(),
        changeSurfaces: {
          availability: "unavailable",
          surfaces: [],
          unavailableLanguages: [{ language: "go", reason: "gopls, go prerequisites unavailable" }],
        },
      },
    })).join("\n");
    expect(lines).toContain("变更面分析不可用: go（gopls, go prerequisites unavailable）");
    expect(lines).not.toContain("C_push=");
  });

  it("does not describe an unavailable before fact as regression", () => {
    const lines = renderDiffReport(report({ summary: { iPush: 4, dMR: 0, deltas: [], historyEntryId: "pending-id", evidenceState: "pending" }, evidence: { mrDetail: [detail("unavailable")], crl: new Map() } })).join("\n");
    expect(lines).toContain("缺少可比 before 结构");
    expect(lines).toContain("未以零值替代；不计入 D_MR");
  });

  it("keeps routine output focused and exposes evidence on demand", () => {
    const value = report({ summary: { iPush: 40, dMR: 0.04, historyEntryId: "pending-id", evidenceState: "pending", deltas: [{ file: "src/zero.ts", alphaStruct: 0.1, deltaI: 0 }, { file: "src/api.ts", alphaStruct: 0.4, deltaI: 40 }] } });
    const summary = renderDiffReport(value, "en", { detail: false }).join("\n");
    expect(summary).toContain("src/api.ts");
    expect(summary).not.toContain("src/zero.ts");
    expect(summary).not.toContain("local deterioration");
    expect(renderDiffReport(value, "en", { detail: true }).join("\n")).toContain("deterioration +0.04");
  });
});
