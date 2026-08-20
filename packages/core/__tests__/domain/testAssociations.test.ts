import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promoteStaticModuleAssociations, staticModuleAssociations } from "../../src/domain/testAssociations";

const demoRoot = resolve(tmpdir(), "openarch-demo");
const posix = (path: string): string => path.replace(/\\/g, "/");
const subjectPath = posix(join(demoRoot, "src", "subject.ts"));
const helperPath = posix(join(demoRoot, "tests", "helper.ts"));
const aGoPath = posix(join(demoRoot, "src", "a.go"));
const bGoPath = posix(join(demoRoot, "src", "b.go"));

describe("staticModuleAssociations", () => {
  it("keeps only resolved production-module imports and labels them low confidence", () => {
    const productionPaths = new Set([subjectPath]);
    expect(staticModuleAssociations([
      { resolvedPath: subjectPath, source: "../src/subject" },
      { resolvedPath: subjectPath, source: "../src/subject-duplicate" },
      { resolvedPath: helperPath, source: "./helper" },
      { resolvedPath: null, source: "vitest" },
    ], productionPaths)).toEqual([{
      targetPath: subjectPath, source: "../src/subject", confidence: "low",
    }]);
  });
});

describe("promoteStaticModuleAssociations", () => {
  it("requires a unique module target, recognised direct call, and parser-confirmed exported function", () => {
    const low = [{ targetPath: subjectPath, source: "../subject", confidence: "low" as const }];
    const promoted = promoteStaticModuleAssociations(low, [{ testName: "calls subject", source: "../subject", symbol: "subject" }], new Map([
      [subjectPath, [{ name: "subject", kind: "function" as const }]],
    ]));
    expect(promoted).toEqual([{
      ...low[0], confidence: "medium", testName: "calls subject", symbol: "subject",
    }]);
  });

  it("retains low evidence when a source resolves to multiple files or no matching export", () => {
    const ambiguous = [
      { targetPath: aGoPath, source: "demo/pkg", confidence: "low" as const },
      { targetPath: bGoPath, source: "demo/pkg", confidence: "low" as const },
    ];
    expect(promoteStaticModuleAssociations(ambiguous, [{ testName: "calls", source: "demo/pkg", symbol: "Run" }], new Map())).toEqual(ambiguous);
  });
});
