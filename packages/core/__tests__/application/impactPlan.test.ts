import { describe, expect, it } from "vitest";
import { buildImpactPlan, symbolUseDemandForProfiles } from "../../src/application/impactPlan";
import { toAbsolute } from "../../src/infra/paths";

describe("buildImpactPlan", () => {
  it("turns a public contract into direct-consumer verification actions", () => {
    const plan = buildImpactPlan([{
      file: "src/api.ts",
      changes: [{ anchor: "Api", kind: "interface_add_remove" }],
    }], new Map([[toAbsolute("src/api.ts"), [toAbsolute("src/client.ts")]]]));

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      file: "src/api.ts",
      publicContracts: ["Api (interface_add_remove)"],
      directConsumers: ["src/client.ts"],
      symbolConsumers: [],
    });
    expect(plan[0].actions).toContainEqual({ kind: "verify_direct_consumers", consumers: ["src/client.ts"] });
  });

  it("does not emit guidance for implementation-only changes", () => {
    expect(buildImpactPlan([{
      file: "src/internal.ts",
      changes: [{ anchor: "compact", kind: "function_body" }],
    }], new Map())).toEqual([]);
  });

  it("turns changed declarations into a bounded symbol-use demand", () => {
    expect(symbolUseDemandForProfiles([{
      file: "src/api.ts",
      changes: [
        { anchor: "Api.publish", kind: "public_method_sig" },
        { anchor: "import:./internal", kind: "dependency_add" },
      ],
    }, {
      file: "src/notes.ts",
      changes: [{ anchor: "file", kind: "comment_whitespace" }],
    }])).toEqual({ declarations: [{ file: "src/api.ts", names: ["publish"] }] });
  });

  it("keeps LSP direct references beside static file consumers without changing the plan's static edge", () => {
    const plan = buildImpactPlan([{
      file: "src/api.rs",
      changes: [{ anchor: "publish", kind: "public_method_sig" }],
    }], new Map([[toAbsolute("src/api.rs"), [toAbsolute("src/lib.rs")]]]), [{
      origin: { language: "rust", providerId: "rust-analyzer-symbol-use", evidenceSource: "lsp" },
      state: { availability: "partial", coverage: { declarations: "complete", repositoryReferences: "partial" }, reason: "Cargo workspace manifests are outside the calibrated single-crate symbol-use scope" },
      facts: [{ language: "rust", declaration: { file: "src/api.rs", name: "publish", kind: "function", line: 3 }, publicSurface: "declared-public", repositoryReferences: [{ file: "src/client.rs", line: 8 }] }],
    }]);

    expect(plan[0]).toMatchObject({
      directConsumers: ["src/lib.rs"],
      symbolConsumers: [{
        symbol: "publish", consumers: ["src/client.rs"], repositoryReferencesCoverage: "partial",
        staticImportConsumers: ["src/lib.rs"], sharedConsumers: [], staticOnlyConsumers: ["src/lib.rs"], symbolOnlyConsumers: ["src/client.rs"],
      }],
    });
  });

  it("excludes the changed file's own internal references from symbol consumers", () => {
    const plan = buildImpactPlan([{
      file: "src/api.ts",
      changes: [{ anchor: "Api.publish", kind: "public_method_sig" }],
    }], new Map(), [{
      origin: { language: "typescript", providerId: "typescript-symbol-use", evidenceSource: "compiler" },
      state: { availability: "partial", coverage: { declarations: "complete", repositoryReferences: "partial" }, reason: "demand-driven" },
      facts: [{
        language: "typescript",
        declaration: { file: "src/api.ts", name: "publish", kind: "method", line: 3 },
        publicSurface: "declared-public",
        repositoryReferences: [
          { file: "src/api.ts", line: 10 },
          { file: "src/client.ts", line: 8 },
        ],
      }],
    }]);

    expect(plan[0].symbolConsumers[0].consumers).toEqual(["src/client.ts"]);
  });
});

describe("evidence gap annotation (defect B3)", () => {
  const availableTsReport = (facts: unknown[]) => ({
    origin: { language: "typescript", providerId: "typescript-symbol-use", evidenceSource: "compiler" as const },
    state: { availability: "available" as const, coverage: { declarations: "complete" as const, repositoryReferences: "complete" as const } },
    facts,
  });
  const publicProfile = (file: string, anchor: string) => ({
    file,
    beforeState: "git" as const,
    changes: [{ anchor, kind: "public_method_sig" as const }],
  });

  it("符号证据不可用时条目携带缺口注解与工具链原因", () => {
    const plan = buildImpactPlan(
      [publicProfile("src/api.ts", "Api.publish")],
      new Map([[toAbsolute("src/api.ts"), [toAbsolute("src/client.ts")]]]),
      undefined,
    );

    expect(plan).toHaveLength(1);
    // 消费者为空但证据不可用：必须与"确证 0 消费者"可区分
    expect(plan[0].symbolConsumers).toEqual([]);
    expect(plan[0].evidenceGap).toEqual({
      file: "src/api.ts",
      language: "typescript",
      kind: "provider-unavailable",
      anchors: ["Api.publish"],
      reason: expect.stringContaining("missing"),
    });
    // 文件级静态事实（I_push/directConsumers 的输入）不因缺口注解而改变
    expect(plan[0].directConsumers).toEqual(["src/client.ts"]);
  });

  it("证据可用且确证 0 消费者时不留缺口（不发明缺口）", () => {
    const plan = buildImpactPlan(
      [publicProfile("src/api.ts", "Api.publish")],
      new Map([[toAbsolute("src/api.ts"), [toAbsolute("src/client.ts")]]]),
      [availableTsReport([])],
    );

    expect(plan[0].symbolConsumers).toEqual([]);
    expect(plan[0].evidenceGap).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(plan[0], "evidenceGap")).toBe(false);
  });

  it("static-bound-empty 的缺口与 provider 不可用缺口种类不同", () => {
    const plan = buildImpactPlan([publicProfile("src/orphan.ts", "orphanHelper")], new Map(), undefined);

    expect(plan[0].evidenceGap).toMatchObject({
      file: "src/orphan.ts",
      kind: "static-bound-empty",
      anchors: ["orphanHelper"],
    });
    expect(plan[0].evidenceGap!.reason).toContain("未查询");
  });

  it("缺口数据只增不改：文件级计划事实与 actions 逐字不变（报告-only）", () => {
    const profiles = [publicProfile("src/api.ts", "Api.publish")];
    const reverseEdges = new Map([[toAbsolute("src/api.ts"), [toAbsolute("src/client.ts"), toAbsolute("src/other.ts")]]]);
    const gapped = buildImpactPlan(profiles, reverseEdges, undefined);
    const resolved = buildImpactPlan(profiles, reverseEdges, [availableTsReport([])]);
    const planFacts = (item: (typeof gapped)[number]) => ({
      file: item.file,
      publicContracts: item.publicContracts,
      implementationUnits: item.implementationUnits,
      dependencyUnits: item.dependencyUnits,
      directConsumers: item.directConsumers,
      actions: item.actions,
    });

    // 缺口与证据可用两种形态下，I_push/deltaI 所依赖的文件级事实与验证动作完全一致
    expect(planFacts(gapped[0])).toEqual(planFacts(resolved[0]));
    expect(gapped[0].directConsumers).toEqual(["src/client.ts", "src/other.ts"]);
    expect(gapped[0].evidenceGap).toBeDefined();
    expect(resolved[0].evidenceGap).toBeUndefined();
    // 唯一新增的键就是缺口注解本身
    expect(Object.keys(gapped[0]).filter((key) => !Object.keys(resolved[0]).includes(key))).toEqual(["evidenceGap"]);
  });
});
