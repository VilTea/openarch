import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { collectTypeScriptSemanticRelations } from "../../src/semantic-relations/typescript";

describe("OpenArch TypeScript workspace semantic-relation calibration", () => {
  it("collects direct repository relations across the core and CLI compiler projects", () => {
    // 仓库根按**测试文件自身位置**定位，不按 `process.cwd()`：此前写作
    // `resolve(process.cwd(), "..", "..")`，只在"仓库根"这一种 cwd 下成立，
    // 换个 cwd 就是 ENOENT 假失败（会被读成回归）。
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const report = collectTypeScriptSemanticRelations(root);

    expect(report).toMatchObject({
      state: {
      availability: "available",
      coverage: { symbols: "complete", relations: "complete" },
      },
    });
    expect(report.scope?.workspaceFingerprint).toContain("packages/core/tsconfig.json");
    expect(report.scope?.workspaceFingerprint).toContain("packages/cli/tsconfig.json");
    expect(report.facts).toContainEqual(expect.objectContaining({
      kind: "extends",
      source: expect.objectContaining({ name: "LanguageRegistration" }),
      target: expect.objectContaining({ name: "LanguageSupport", scope: "repository" }),
      evidence: expect.objectContaining({ file: "packages/core/src/adapter/parser/LanguageRegistry.ts" }),
    }));
    expect(report.facts).toContainEqual(expect.objectContaining({
      kind: "instantiates",
      source: expect.objectContaining({ name: "Parser" }),
      target: expect.objectContaining({ name: "RuleCompileError", scope: "repository" }),
      evidence: expect.objectContaining({ file: "packages/core/src/adapter/rule/CelAdapter.ts" }),
    }));
    expect(report.facts.every((fact) => fact.source.scope === "repository" && fact.target.scope === "repository")).toBe(true);
  });
});
