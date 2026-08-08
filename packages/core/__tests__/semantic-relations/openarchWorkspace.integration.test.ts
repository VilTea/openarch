import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { collectTypeScriptSemanticRelations } from "../../src/semantic-relations/typescript";

describe("OpenArch TypeScript workspace semantic-relation calibration", () => {
  it("collects direct repository relations across the core and CLI compiler projects", () => {
    const root = resolve(process.cwd(), "..", "..");
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
