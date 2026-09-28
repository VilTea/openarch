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
  shape: { connectednessBefore: beforeSource === "unavailable" ? null : 0.9, connectednessAfter: beforeSource === "unavailable" ? null : 0.6, moduleShapeDelta: beforeSource === "unavailable" ? null : 0.3, functionCountDelta: beforeSource === "unavailable" ? null : 12, singleCallSiteRatioDelta: beforeSource === "unavailable" ? null : 0.56 },
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

  it("renders cognitive-point shape alongside D_MR without folding it into the sum", () => {
    const lines = renderDiffReport(report()).join("\n");
    // 认知点形态是并列事实：机械分解可以让 gate 变绿而这里同时变差。
    expect(lines).toContain("认知点形态:");
    expect(lines).toContain("不连通形态(1-connectedness) Δ +0.300（正=更碎）");
    expect(lines).toContain("函数/声明数 Δ +12（正=新增了抽象）");
    // 单调用点助手占比与"更碎"并读：图仍连通但助手只用一次的比例升高。
    expect(lines).toContain("单调用点助手占比 Δ +0.560（正=新增的抽象里只用一次的更多）");
    // 它不得改变局部负担的求和口径。
    expect(lines).toContain("局部恶化 +0.04，改善 -0.01；暴露 Δα=+0.100");
  });

  it("旧证据缺少单调用点字段时静默跳过，不渲染 NaN", () => {
    // shape 存在但缺后加字段（会话内更早持久化的证据）：不得抛错或渲染 NaN。
    const legacy = { ...detail(), shape: { connectednessBefore: 0.9, connectednessAfter: 0.6, moduleShapeDelta: 0.3, functionCountDelta: 12 } } as unknown as ReturnType<typeof detail>;
    const lines = renderDiffReport(report({ evidence: { mrDetail: [legacy], crl: new Map() } })).join("\n");
    expect(lines).toContain("不连通形态(1-connectedness) Δ +0.300");
    expect(lines).not.toContain("单调用点助手占比");
    expect(lines).not.toContain("NaN");
  });

  it("omits the shape clause when a persisted record predates the field", () => {
    const legacy = { ...detail(), shape: undefined } as unknown as ReturnType<typeof detail>;
    const lines = renderDiffReport(report({ evidence: { mrDetail: [legacy], crl: new Map() } })).join("\n");
    expect(lines).not.toContain("认知点形态");
    expect(lines).toContain("局部恶化 +0.04，改善 -0.01；暴露 Δα=+0.100");
  });

  it("explains a zero D_MR as no local-burden deterioration", () => {
    expect(renderDiffReport(report({ summary: { iPush: 12, dMR: 0, deltas: [], historyEntryId: "history-id", evidenceState: "sealed" }, evidence: { mrDetail: [], crl: new Map() } })).join("\n")).toContain("无局部负担恶化（0.00，不参与 gate）");
  });

  it("renders intensity and the project-relative scale as routing evidence", () => {
    const lines = renderDiffReport(report({
      summary: {
        iPush: 40, dMR: 0, deltas: [{ file: "src/api.ts", alphaStruct: 0.4, deltaI: 40 }],
        historyEntryId: "pending-id", evidenceState: "pending",
        severityBudget: 100, intensity: 0.4,
        impactScale: { percentile: 62.5, bucket: "2-3", sampleEntries: 8 },
      },
      evidence: { mrDetail: [], crl: new Map() },
    })).join("\n");
    expect(lines).toContain("I_push 强度: 0.40/λ_ast（severity budget 100.0）");
    expect(lines).toContain("本次冲击高于同规模（2-3 文件）sealed 变更的 62.5%（样本 8 条");
  });

  it("never presents a missing same-size sample as a zero percentile", () => {
    const lines = renderDiffReport(report({
      summary: { iPush: 40, dMR: 0, deltas: [], historyEntryId: "pending-id", evidenceState: "pending", severityBudget: 100, intensity: 0.4 },
      evidence: { mrDetail: [], crl: new Map() },
    })).join("\n");
    expect(lines).toContain("暂无同规模 sealed 变更样本（不是 0 分位）");
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

  it("suppresses file-heavy when C_push is a confirmed zero-consumer surface, keeps it when unconfirmed", () => {
    const confirmedZero = renderDiffReport(report({
      summary: { iPush: 40, dMR: 0, deltas: [{ file: "src/hot.ts", alphaStruct: 0.4, deltaI: 40 }], historyEntryId: "pending-id", evidenceState: "pending" },
      evidence: {
        mrDetail: [], crl: new Map(),
        changeSurfaces: {
          availability: "available",
          surfaces: [{
            file: "src/hot.ts", language: "typescript", staticBound: 0,
            result: {
              provenance: "static-bound-empty",
              contributions: [{ anchor: "compact", kind: "function_body", lambdaAst: 10, consumers: [], reachFactor: 0, layerWeight: 0, contribution: 0, unconfirmed: false }],
              total: 0,
              consumersByAnchor: new Map([["compact", []]]),
            },
          }],
          unavailableLanguages: [],
        },
      },
    })).join("\n");
    expect(confirmedZero).not.toContain("信号[file-heavy]");

    const missingUnconfirmed = renderDiffReport(report({
      summary: { iPush: 40, dMR: 0, deltas: [{ file: "src/hot.ts", alphaStruct: 0.4, deltaI: 40 }], historyEntryId: "pending-id", evidenceState: "pending" },
      evidence: {
        mrDetail: [], crl: new Map(),
        changeSurfaces: {
          availability: "available",
          surfaces: [{
            file: "src/hot.ts", language: "typescript", staticBound: 3,
            result: {
              provenance: "symbol",
              // 缺少 unconfirmed 字段的旧 surface 也必须 fail-closed：不得当作确认零消费者。
              contributions: [{ anchor: "compact", kind: "function_body", lambdaAst: 10, consumers: [], reachFactor: 0, layerWeight: 0, contribution: 0 }] as never,
              total: 0,
              consumersByAnchor: new Map([["compact", []]]),
            },
          }],
          unavailableLanguages: [],
        },
      },
    })).join("\n");
    expect(missingUnconfirmed).toContain("信号[file-heavy]");

    const unconfirmedZero = renderDiffReport(report({
      summary: { iPush: 40, dMR: 0, deltas: [{ file: "src/hot.ts", alphaStruct: 0.4, deltaI: 40 }], historyEntryId: "pending-id", evidenceState: "pending" },
      evidence: {
        mrDetail: [], crl: new Map(),
        changeSurfaces: {
          availability: "available",
          surfaces: [{
            file: "src/hot.ts", language: "typescript", staticBound: 3,
            result: {
              provenance: "symbol",
              contributions: [{ anchor: "compact", kind: "function_body", lambdaAst: 10, consumers: [], reachFactor: 0, layerWeight: 0, contribution: 0, unconfirmed: true }],
              total: 0,
              consumersByAnchor: new Map([["compact", []]]),
            },
          }],
          unavailableLanguages: [],
        },
      },
    })).join("\n");
    expect(unconfirmedZero).toContain("信号[file-heavy]");
  });

  it("renders unavailable languages without emitting any C_push value", () => {
    const lines = renderDiffReport(report({
      summary: { iPush: 40, dMR: 0, deltas: [{ file: "src/api.go", alphaStruct: 0.4, deltaI: 40 }], historyEntryId: "pending-id", evidenceState: "pending" },
      evidence: {
        mrDetail: [], crl: new Map(),
        changeSurfaces: {
          availability: "unavailable",
          surfaces: [],
          unavailableLanguages: [{ language: "go", reason: "gopls, go prerequisites unavailable", files: ["src/api.go"] }],
        },
      },
    })).join("\n");
    expect(lines).toContain("变更面分析不可用: go（gopls, go prerequisites unavailable）");
    expect(lines).toContain("→ 受影响文件: src/api.go");
    expect(lines).not.toContain("C_push=");
  });

  it("区分「证据缺口」与「已确证的 0 消费者」（校准 2026-09-25）", () => {
    const withGap = renderDiffReport(report({
      summary: { iPush: 4, dMR: 0, deltas: [{ file: "src/api.ts", alphaStruct: 0.4, deltaI: 4 }], historyEntryId: "pending-id", evidenceState: "pending" },
      evidence: {
        mrDetail: [], crl: new Map(),
        changeSurfaces: {
          availability: "available",
          surfaces: [],
          unavailableLanguages: [{ language: "java", reason: "jdtls unavailable", files: ["src/A.java", "src/B.java"] }],
          symbolEvidenceGaps: [
            { file: "src/A.java", language: "java", kind: "provider-unavailable", anchors: ["A.run"], reason: "jdtls, javac prerequisites unavailable" },
            { file: "src/C.ts", language: "typescript", kind: "static-bound-empty", anchors: ["C.run"], reason: "静态上界为空：0 消费者是结构性结论，非符号级确证" },
          ],
        },
        impactPlan: [{
          file: "src/A.java", publicContracts: [], implementationUnits: [], dependencyUnits: [], directConsumers: [],
          symbolConsumers: [], actions: [],
          evidenceGap: { file: "src/A.java", language: "java", kind: "provider-unavailable", anchors: ["A.run"], reason: "jdtls, javac prerequisites unavailable" },
        }],
      },
    })).join("\n");
    expect(withGap).toContain("受影响文件: src/A.java, src/B.java");
    expect(withGap).toContain("符号/可见性证据缺口（空消费者列表表示未知，不等于已确证的 0）");
    expect(withGap).toContain("[证据不可用] src/A.java: jdtls, javac prerequisites unavailable");
    // 静态上界为空也必须留下缺口：否则文件看起来"已完全解析"。
    expect(withGap).toContain("[静态上界为空（未查询符号证据）] src/C.ts");
    expect(withGap).toContain("证据缺口: jdtls, javac prerequisites unavailable（symbolConsumers 为空表示未知，不是已确证的 0）");

    // 证据可用且真的 0 消费者 ⇒ 不得出现缺口措辞。
    const resolved = renderDiffReport(report({
      summary: { iPush: 4, dMR: 0, deltas: [{ file: "src/api.ts", alphaStruct: 0.4, deltaI: 4 }], historyEntryId: "pending-id", evidenceState: "pending" },
      evidence: {
        mrDetail: [], crl: new Map(),
        changeSurfaces: {
          availability: "available", surfaces: [], unavailableLanguages: [], symbolEvidenceGaps: [],
        },
        impactPlan: [{
          file: "src/api.ts", publicContracts: [], implementationUnits: [], dependencyUnits: [], directConsumers: [],
          symbolConsumers: [], actions: [],
        }],
      },
    })).join("\n");
    expect(resolved).not.toContain("符号/可见性证据缺口");
    expect(resolved).not.toContain("证据缺口:");
  });

  it("旧证据缺少 files/gaps 字段时不抛错、也不编造缺口", () => {
    // changeSurfaces 会随 evidence 持久化，旧记录没有这些加法字段。
    const legacy = renderDiffReport(report({
      summary: { iPush: 4, dMR: 0, deltas: [], historyEntryId: "pending-id", evidenceState: "pending" },
      evidence: {
        mrDetail: [], crl: new Map(),
        changeSurfaces: {
          availability: "unavailable", surfaces: [],
          unavailableLanguages: [{ language: "go", reason: "gopls unavailable" }],
        } as never,
      },
    })).join("\n");
    expect(legacy).toContain("变更面分析不可用: go");
    expect(legacy).not.toContain("受影响文件");
    expect(legacy).not.toContain("符号/可见性证据缺口");
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
