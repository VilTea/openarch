import { describe, expect, it } from "vitest";
import { promoteStaticModuleAssociations, staticModuleAssociations } from "../../src/domain/testAssociations";

describe("staticModuleAssociations", () => {
  it("keeps only resolved production-module imports and labels them low confidence", () => {
    const productionPaths = new Set(["E:/workspace/demo/src/subject.ts"]);
    expect(staticModuleAssociations([
      { resolvedPath: "E:/workspace/demo/src/subject.ts", source: "../src/subject" },
      { resolvedPath: "E:/workspace/demo/src/subject.ts", source: "../src/subject-duplicate" },
      { resolvedPath: "E:/workspace/demo/tests/helper.ts", source: "./helper" },
      { resolvedPath: null, source: "vitest" },
    ], productionPaths)).toEqual([{
      targetPath: "E:/workspace/demo/src/subject.ts", source: "../src/subject", confidence: "low",
    }]);
  });
});

describe("promoteStaticModuleAssociations", () => {
  it("requires a unique module target, recognised direct call, and parser-confirmed exported function", () => {
    const low = [{ targetPath: "E:/workspace/demo/src/subject.ts", source: "../subject", confidence: "low" as const }];
    const promoted = promoteStaticModuleAssociations(low, [{ testName: "calls subject", source: "../subject", symbol: "subject" }], new Map([
      ["E:/workspace/demo/src/subject.ts", [{ name: "subject", kind: "function" as const }]],
    ]));
    expect(promoted).toEqual([{
      ...low[0], confidence: "medium", testName: "calls subject", symbol: "subject",
    }]);
  });

  it("retains low evidence when a source resolves to multiple files or no matching export", () => {
    const ambiguous = [
      { targetPath: "E:/workspace/demo/src/a.go", source: "demo/pkg", confidence: "low" as const },
      { targetPath: "E:/workspace/demo/src/b.go", source: "demo/pkg", confidence: "low" as const },
    ];
    expect(promoteStaticModuleAssociations(ambiguous, [{ testName: "calls", source: "demo/pkg", symbol: "Run" }], new Map())).toEqual(ambiguous);
  });
});
