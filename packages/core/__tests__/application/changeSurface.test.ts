import { describe, expect, it } from "vitest";
import { computeChangeSurfaceForProfiles } from "../../src/application/changeSurface";
import { toAbsolute } from "../../src/infra/paths";

const pathClasses = [
  { pattern: "packages/app/src/**", name: "app", weight: 2.0 },
  { pattern: "**", name: "default", weight: 1.0 },
];

const availableTsReport = (facts: unknown[]) => ({
  origin: { language: "typescript", providerId: "typescript-symbol-use", evidenceSource: "compiler" as const },
  state: { availability: "available" as const, coverage: { declarations: "complete" as const, repositoryReferences: "complete" as const } },
  facts,
});

describe("computeChangeSurfaceForProfiles", () => {
  it("symbol 证据：按文件+叶子名配对消费者，排除变更文件自身，ω 按消费者取 max", () => {
    const collection = computeChangeSurfaceForProfiles({
      profiles: [{
        file: "packages/app/src/api.ts",
        beforeState: "git",
        changes: [
          { anchor: "Api.publish", kind: "public_method_sig" },
          { anchor: "compact", kind: "function_body" },
        ],
      }],
      reverseEdges: new Map([[toAbsolute("packages/app/src/api.ts"), [toAbsolute("packages/app/src/client-a.ts"), toAbsolute("packages/app/src/client-b.ts")]]]),
      symbolUseReports: [availableTsReport([
        {
          language: "typescript",
          declaration: { file: "packages/app/src/api.ts", name: "publish", kind: "method", line: 5 },
          publicSurface: "declared-public",
          repositoryReferences: [
            { file: "packages/app/src/client-a.ts", line: 12 },
            { file: "packages/app/src/client-b.ts", line: 30 },
            { file: "packages/app/src/api.ts", line: 8 },
          ],
        },
        {
          language: "typescript",
          declaration: { file: "packages/app/src/api.ts", name: "compact", kind: "function", line: 20 },
          publicSurface: "internal",
          repositoryReferences: [],
        },
      ])],
      reverseEdges: new Map([[toAbsolute("packages/app/src/api.ts"), [toAbsolute("packages/app/src/client-a.ts"), toAbsolute("packages/app/src/client-b.ts")]]]),
      pathClasses,
    });
    expect(collection.availability).toBe("available");
    expect(collection.unavailableLanguages).toEqual([]);
    expect(collection.surfaces).toHaveLength(1);
    expect(collection.surfaces[0]).toMatchObject({ file: "packages/app/src/api.ts", language: "typescript", staticBound: 2 });

    const publish = collection.surfaces[0].result.contributions.find((c) => c.anchor === "Api.publish")!;
    expect(publish.consumers).toEqual(["packages/app/src/client-a.ts", "packages/app/src/client-b.ts"]);
    expect(publish.lambdaAst).toBe(60);
    expect(publish.layerWeight).toBe(2.0); // client-b 在 app 层 weight=2.0
    expect(publish.contribution).toBeCloseTo(60 * Math.log2(3) * 2.0, 6);

    const compact = collection.surfaces[0].result.contributions.find((c) => c.anchor === "compact")!;
    expect(compact.consumers).toEqual([]);
    expect(compact.contribution).toBe(0);

    expect(collection.surfaces[0].result.total).toBeCloseTo(60 * Math.log2(3) * 2.0, 6);
  });

  it("reports 缺失时不输出 C_push 数值，汇入 unavailableLanguages（无兜底）", () => {
    const collection = computeChangeSurfaceForProfiles({
      profiles: [{
        file: "src/api.ts",
        beforeState: "git",
        changes: [{ anchor: "Api.publish", kind: "public_method_sig" }],
      }],
      symbolUseReports: undefined,
      reverseEdges: new Map([[toAbsolute("src/api.ts"), [toAbsolute("src/client.ts")]]]),
      pathClasses,
    });

    expect(collection.availability).toBe("unavailable");
    expect(collection.surfaces).toEqual([]);
    expect(collection.unavailableLanguages).toEqual([{ language: "typescript", reason: expect.stringContaining("missing"), files: ["src/api.ts"] }]);
  });

  it("report unavailable 时不输出该语言 C_push 数值，带原因", () => {
    const collection = computeChangeSurfaceForProfiles({
      profiles: [{
        file: "src/api.rs",
        beforeState: "git",
        changes: [{ anchor: "publish", kind: "public_method_sig" }],
      }],
      symbolUseReports: [{
        origin: { language: "rust", providerId: "rust-analyzer-symbol-use", evidenceSource: "lsp" },
        state: { availability: "unavailable", coverage: { declarations: "unavailable", repositoryReferences: "unavailable" }, reason: "rust-analyzer executable is unavailable" },
        facts: [],
      }],
      reverseEdges: new Map([[toAbsolute("src/api.rs"), [toAbsolute("src/lib.rs")]]]),
      pathClasses,
    });

    expect(collection.surfaces).toEqual([]);
    expect(collection.unavailableLanguages).toEqual([{ language: "rust", reason: "rust-analyzer executable is unavailable", files: ["src/api.rs"] }]);
  });

  it("LSP 引用采集不完整（incomplete）时不输出 C_push（0 消费者会误导）", () => {
    const collection = computeChangeSurfaceForProfiles({
      profiles: [{
        file: "src/api.rs",
        beforeState: "git",
        changes: [{ anchor: "publish", kind: "public_method_sig" }],
      }],
      symbolUseReports: [{
        origin: { language: "rust", providerId: "rust-analyzer-symbol-use", evidenceSource: "lsp" },
        state: {
          availability: "partial",
          coverage: { declarations: "partial", repositoryReferences: "partial" },
          reason: "demand-driven semantic query selected 1/12 governed declaration files; LSP document or reference collection is incomplete",
        },
        facts: [],
      }],
      reverseEdges: new Map([[toAbsolute("src/api.rs"), [toAbsolute("src/lib.rs")]]]),
      pathClasses,
    });

    expect(collection.surfaces).toEqual([]);
    expect(collection.unavailableLanguages[0].language).toBe("rust");
    expect(collection.unavailableLanguages[0].reason).toContain("不完整");
  });

  it("LSP 引用采集不完整但已有确认消费者 → 输出符号级 C_push（单项目刚需，风险标注由报告层携带）", () => {
    const collection = computeChangeSurfaceForProfiles({
      profiles: [{
        file: "src/api.py",
        beforeState: "git",
        changes: [{ anchor: "publish", kind: "public_method_sig" }],
      }],
      symbolUseReports: [{
        origin: { language: "python", providerId: "python-pyright-symbol-use", evidenceSource: "lsp" },
        state: {
          availability: "partial",
          coverage: { declarations: "partial", repositoryReferences: "partial" },
          reason: "demand-driven semantic query selected 1/2 governed declaration files; LSP document or reference collection is incomplete",
        },
        facts: [{ declaration: { file: "src/api.py", name: "publish", line: 3, column: 0 }, repositoryReferences: [{ file: "src/main.py", name: "publish", line: 1, column: 0 }] }],
      }],
      reverseEdges: new Map([[toAbsolute("src/api.py"), [toAbsolute("src/main.py")]]]),
      pathClasses,
    });

    expect(collection.unavailableLanguages).toEqual([]);
    expect(collection.surfaces).toHaveLength(1);
    const surface = collection.surfaces[0]!;
    expect(surface.result.provenance).toBe("symbol");
    expect(surface.result.consumersByAnchor.get("publish")).toEqual(["src/main.py"]);
  });

  it("Python 动态解析风险（references are not complete）也不输出 C_push", () => {
    const collection = computeChangeSurfaceForProfiles({
      profiles: [{
        file: "src/click/core.py",
        beforeState: "git",
        changes: [{ anchor: "manual:file", kind: "function_body" }],
      }],
      symbolUseReports: [{
        origin: { language: "python", providerId: "python-pyright-symbol-use", evidenceSource: "lsp" },
        state: {
          availability: "partial",
          coverage: { declarations: "partial", repositoryReferences: "partial" },
          reason: "parser detected dynamic Python import or attribute resolution; repository references are not complete",
        },
        facts: [],
      }],
      reverseEdges: new Map([[toAbsolute("src/click/core.py"), [toAbsolute("src/click/utils.py")]]]),
      pathClasses,
    });

    expect(collection.surfaces).toEqual([]);
    expect(collection.unavailableLanguages[0].language).toBe("python");
  });

  it("仅 import 变更的 profile 不产出 C_push（依赖图维度由 I_push 覆盖）", () => {
    const collection = computeChangeSurfaceForProfiles({
      profiles: [{
        file: "src/api.ts",
        beforeState: "git",
        changes: [{ anchor: "import:./helper", kind: "dependency_add" }],
      }],
      symbolUseReports: [availableTsReport([])],
      reverseEdges: new Map(),
      pathClasses,
    });
    expect(collection.surfaces).toEqual([]);
  });

  it("静态上界非空但符号级 0 消费者 → unconfirmed（不是结论 0）", () => {
    const collection = computeChangeSurfaceForProfiles({
      profiles: [{
        file: "src/api.rs",
        beforeState: "git",
        changes: [{ anchor: "unreferencedPublic", kind: "function_sig" }],
      }],
      symbolUseReports: [{
        origin: { language: "rust", providerId: "rust-analyzer-symbol-use", evidenceSource: "lsp" },
        state: { availability: "partial", coverage: { declarations: "partial", repositoryReferences: "partial", incompleteReferences: false } },
        facts: [],
      }],
      reverseEdges: new Map([[toAbsolute("src/api.rs"), [toAbsolute("src/lib.rs")]]]),
      pathClasses,
    });

    expect(collection.surfaces).toHaveLength(1);
    expect(collection.surfaces[0].staticBound).toBe(1);
    const contribution = collection.surfaces[0].result.contributions[0];
    expect(contribution.unconfirmed).toBe(true);
    expect(contribution.consumers).toEqual([]);
  });

  it("静态上界为空 → static-bound-empty 0 消费者（无需 LSP，逻辑必然）", () => {
    const collection = computeChangeSurfaceForProfiles({
      profiles: [{
        file: "src/orphan.ts",
        beforeState: "git",
        changes: [{ anchor: "orphanHelper", kind: "function_body" }],
      }],
      symbolUseReports: undefined,
      reverseEdges: new Map(),
      pathClasses,
    });

    expect(collection.availability).toBe("available");
    expect(collection.surfaces).toHaveLength(1);
    expect(collection.surfaces[0].staticBound).toBe(0);
    expect(collection.surfaces[0].result.provenance).toBe("static-bound-empty");
    expect(collection.surfaces[0].result.contributions[0].consumers).toEqual([]);
    expect(collection.surfaces[0].result.total).toBe(0);
    expect(collection.unavailableLanguages).toEqual([]);
    // 缺陷 B3 第二处：该分支此前完全静默，文件看起来"已确证 0 消费者"。
    // 语言键投影按既有行为不新增条目，但逐文件缺口必须显式记账。
    expect(collection.symbolEvidenceGaps).toEqual([{
      file: "src/orphan.ts",
      language: "typescript",
      kind: "static-bound-empty",
      anchors: ["orphanHelper"],
      reason: expect.stringContaining("未查询"),
    }]);
  });
});

describe("cross-package intersection guard (calibration 2026-08-05)", () => {
  it("符号级消费者与静态上界完全不重叠 → 不输出 C_push，汇入 unavailableLanguages", () => {
    const collection = computeChangeSurfaceForProfiles({
      profiles: [{
        file: "src/registry.go",
        beforeState: "git",
        changes: [{ anchor: "NewRegistry", kind: "public_method_sig" }],
      }],
      reverseEdges: new Map([[toAbsolute("src/registry.go"), [toAbsolute("examples/a/main.go"), toAbsolute("examples/b/main.go")]]]),
      symbolUseReports: [{
        origin: { language: "go", providerId: "go-gopls-symbol-use", evidenceSource: "lsp" },
        state: {
          availability: "partial",
          coverage: { declarations: "partial", repositoryReferences: "partial", incompleteReferences: false },
        },
        facts: [{
          language: "go",
          declaration: { file: "src/registry.go", name: "NewRegistry", kind: "function", line: 67 },
          publicSurface: "declared-public",
          repositoryReferences: [
            { file: "src/registry_test.go", line: 30 },
            { file: "src/example_metricvec_test.go", line: 12 },
          ],
        }],
      }],
      pathClasses,
    });
    expect(collection.surfaces).toHaveLength(0);
    expect(collection.unavailableLanguages[0]?.language).toBe("go");
    expect(collection.unavailableLanguages[0]?.reason).toContain("无交集");
  });

  it("符号级与静态上界有交集 → 照常输出 C_push", () => {
    const collection = computeChangeSurfaceForProfiles({
      profiles: [{
        file: "src/api.ts",
        beforeState: "git",
        changes: [{ anchor: "publish", kind: "function_sig" }],
      }],
      reverseEdges: new Map([[toAbsolute("src/api.ts"), [toAbsolute("src/client-a.ts")]]]),
      symbolUseReports: [availableTsReport([
        {
          language: "typescript",
          declaration: { file: "src/api.ts", name: "publish", kind: "function", line: 5 },
          publicSurface: "declared-public",
          repositoryReferences: [{ file: "src/client-a.ts", line: 12 }],
        },
      ])],
      pathClasses,
    });
    expect(collection.surfaces).toHaveLength(1);
    expect(collection.surfaces[0]!.result.provenance).toBe("symbol");
  });
});

describe("evidence gap accounting (defect B3)", () => {
  it("provider 不可用：不可用事实点名受影响文件，而不只是语言", () => {
    const collection = computeChangeSurfaceForProfiles({
      profiles: [
        { file: "src/api.ts", beforeState: "git", changes: [{ anchor: "publish", kind: "public_method_sig" }] },
        { file: "src/other.ts", beforeState: "git", changes: [{ anchor: "other", kind: "function_sig" }] },
      ],
      symbolUseReports: undefined,
      reverseEdges: new Map([
        [toAbsolute("src/api.ts"), [toAbsolute("src/client.ts")]],
        [toAbsolute("src/other.ts"), [toAbsolute("src/consumer.ts")]],
      ]),
      pathClasses,
    });

    expect(collection.surfaces).toEqual([]);
    // 语言键投影保持既有字段语义，同时携带受影响文件（同语言聚合、profile 顺序）
    expect(collection.unavailableLanguages).toEqual([{
      language: "typescript",
      reason: expect.stringContaining("missing"),
      files: ["src/api.ts", "src/other.ts"],
    }]);
    // 逐文件缺口：哪个文件、哪条声明、什么原因，一目了然
    expect(collection.symbolEvidenceGaps).toEqual([
      { file: "src/api.ts", language: "typescript", kind: "provider-unavailable", anchors: ["publish"], reason: expect.stringContaining("missing") },
      { file: "src/other.ts", language: "typescript", kind: "provider-unavailable", anchors: ["other"], reason: expect.stringContaining("missing") },
    ]);
  });

  it("工具链不可用：缺口原因就是 provider 的权威原因（不在别处重算）", () => {
    const collection = computeChangeSurfaceForProfiles({
      profiles: [{
        file: "src/api.rs",
        beforeState: "git",
        changes: [{ anchor: "publish", kind: "public_method_sig" }],
      }],
      symbolUseReports: [{
        origin: { language: "rust", providerId: "rust-analyzer-symbol-use", evidenceSource: "lsp" },
        state: { availability: "unavailable", coverage: { declarations: "unavailable", repositoryReferences: "unavailable" }, reason: "rust-analyzer executable is unavailable" },
        facts: [],
      }],
      reverseEdges: new Map([[toAbsolute("src/api.rs"), [toAbsolute("src/lib.rs")]]]),
      pathClasses,
    });

    expect(collection.unavailableLanguages).toEqual([
      { language: "rust", reason: "rust-analyzer executable is unavailable", files: ["src/api.rs"] },
    ]);
    expect(collection.symbolEvidenceGaps).toEqual([{
      file: "src/api.rs",
      language: "rust",
      kind: "provider-unavailable",
      anchors: ["publish"],
      reason: "rust-analyzer executable is unavailable",
    }]);
  });

  it("static-bound-empty：保留 provenance 与数值，同时留下显式未查询缺口", () => {
    const collection = computeChangeSurfaceForProfiles({
      profiles: [{
        file: "src/orphan.ts",
        beforeState: "git",
        changes: [{ anchor: "orphanHelper", kind: "function_body" }],
      }],
      symbolUseReports: undefined,
      reverseEdges: new Map(),
      pathClasses,
    });

    // 既有行为不变：C_push=0 仍是结构性结论，availability 与数值一字不改
    expect(collection.availability).toBe("available");
    expect(collection.surfaces[0]!.result.provenance).toBe("static-bound-empty");
    expect(collection.surfaces[0]!.staticBound).toBe(0);
    expect(collection.surfaces[0]!.result.total).toBe(0);
    // 缺口：符号/可见性证据未查询，不得被读成"符号级已确证 0 消费者"
    expect(collection.symbolEvidenceGaps).toHaveLength(1);
    expect(collection.symbolEvidenceGaps[0]).toMatchObject({
      file: "src/orphan.ts",
      kind: "static-bound-empty",
      anchors: ["orphanHelper"],
    });
    expect(collection.symbolEvidenceGaps[0]!.reason).toContain("未查询");
    // 与 provider 不可用可区分：这是"结构性 0，但证据未查询"，不是工具链故障
    expect(collection.symbolEvidenceGaps.map((gap) => gap.kind)).toEqual(["static-bound-empty"]);
  });

  it("证据真正可用时不留任何缺口（不发明缺口）", () => {
    const collection = computeChangeSurfaceForProfiles({
      profiles: [{
        file: "packages/app/src/api.ts",
        beforeState: "git",
        changes: [{ anchor: "Api.publish", kind: "public_method_sig" }],
      }],
      reverseEdges: new Map([[toAbsolute("packages/app/src/api.ts"), [toAbsolute("packages/app/src/client-a.ts")]]]),
      symbolUseReports: [availableTsReport([
        {
          language: "typescript",
          declaration: { file: "packages/app/src/api.ts", name: "publish", kind: "method", line: 5 },
          publicSurface: "declared-public",
          repositoryReferences: [{ file: "packages/app/src/client-a.ts", line: 12 }],
        },
      ])],
      pathClasses,
    });

    expect(collection.symbolEvidenceGaps).toEqual([]);
    expect(collection.unavailableLanguages).toEqual([]);
    expect(collection.surfaces[0]!.result.provenance).toBe("symbol");
  });
});
