import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { computeFileImpact } from "../../src/application/diffImpact";
import type { FileAst } from "../../src/domain/ast";

const absPath = resolve("src/contracts.ts").replace(/\\/g, "/");

const ast: FileAst = {
  path: "src/contracts.ts",
  language: "typescript",
  branchCount: 0,
  nestingDepth: 0,
  functionCount: 1,
  passthroughCalls: 1,
  imports: [],
  functions: [{ name: "make", branchCount: 0, calls: [] }],
};

const impactFor = (changeKind: import("../../src/domain/weights").ChangeKind) => computeFileImpact({
  ast,
  graph: new Map(),
  inDegrees: new Map([[absPath, 2]]),
  reverseEdges: new Map([[absPath, ["consumer-a", "consumer-b"]]]),
  changedSet: new Set([absPath]),
  nFiles: 10,
  changeKinds: [changeKind],
  pathClasses: [],
  crlStateWeights: { branch: 1, nesting: 1, loc: 1, externalPassthrough: 1 },
});

describe("compatible contract impact", () => {
  it("does not penalize unchanged consumers for an additive optional field", () => {
    const compatible = impactFor("compatible_field_add");
    const implementation = impactFor("function_body");

    // lambda 5 and no completion penalty, versus lambda 10 with gamma_completion=2.
    expect(compatible.deltaI / implementation.deltaI).toBeCloseTo(0.25, 6);
  });

  it("preserves parser-confirmed re-export relations when diff refreshes a baseline entry", () => {
    const reexportAst: FileAst = {
      ...ast,
      imports: [{ source: "./public-api", resolvedPath: resolve("src/public-api.ts").replace(/\\/g, "/"), relation: "reexport" }],
    };

    const impact = computeFileImpact({
      ast: reexportAst,
      graph: new Map(),
      inDegrees: new Map([[absPath, 2]]),
      reverseEdges: new Map([[absPath, ["consumer-a", "consumer-b"]]]),
      changedSet: new Set([absPath]),
      nFiles: 10,
      changeKinds: ["function_body"],
      pathClasses: [],
      oldEntry: {
        path: "src/contracts.ts", fileKind: "production", branchCount: 0, nestingDepth: 0,
        inDegree: 0, outDegree: 0, alphaStruct: 0,
        localBurdenFingerprint: "a".repeat(64),
      },
      crlStateWeights: { branch: 1, nesting: 1, loc: 1, externalPassthrough: 1 },
    });

    expect(impact.writeEntry.reexports).toEqual(["src/public-api.ts"]);
    expect(impact.writeEntry.localBurdenFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(impact.writeEntry.previousLocalBurdenFingerprint).toBe("a".repeat(64));
  });

  it("uses the sealed baseline for an existing file with a manual semantic override", () => {
    const impact = computeFileImpact({
      ast: { ...ast, loc: 10, maxFuncBranch: 2 },
      graph: new Map(),
      inDegrees: new Map(),
      reverseEdges: new Map(),
      changedSet: new Set(),
      nFiles: 10,
      changeKinds: ["function_body"],
      pathClasses: [],
      semanticBeforeState: "unavailable",
      oldEntry: {
        path: "src/contracts.ts", fileKind: "production", branchCount: 5, maxFuncBranch: 5, nestingDepth: 3, loc: 30,
        externalPassthroughCalls: 4, inDegree: 0, outDegree: 0, alphaStruct: 0.2,
        localBurdenFingerprint: "a".repeat(64),
      },
      p95: { branch: 10, nesting: 10, loc: 100, alpha: 1, oneMinusConnectedness: 1, externalPassthrough: 10 },
      crlStateWeights: { branch: 1, nesting: 1, loc: 1, externalPassthrough: 1 },
    });

    expect(impact.mrDetail).toMatchObject({ scope: "existing", beforeSource: "baseline" });
    expect(impact.mrDetail.localBurden.metrics.loc).toMatchObject({ before: 30, after: 10, delta: -20 });
    expect(impact.mrDetail.localBurden.improvement).toBeGreaterThan(0);
  });

  it("preserves the complete scan fact contract while keeping tests outside production metrics", () => {
    const impact = computeFileImpact({
      ast: { ...ast, path: "src/__tests__/contracts.test.ts", externalPassthroughCalls: undefined },
      graph: new Map(),
      inDegrees: new Map(),
      reverseEdges: new Map(),
      changedSet: new Set(),
      nFiles: 10,
      changeKinds: ["function_body"],
      pathClasses: [],
      oldEntry: {
        path: "src/__tests__/contracts.test.ts", fileKind: "test", branchCount: 0, nestingDepth: 0,
        inDegree: 0, outDegree: 0, alphaStruct: 0,
        localBurdenFingerprint: "f".repeat(64),
        testMetrics: { schemaVersion: "1", providerId: "typescript-vitest", tests: [], findings: [] },
      },
      crlStateWeights: { branch: 1, nesting: 1, loc: 1, externalPassthrough: 1 },
    });

    expect(impact.writeEntry).toMatchObject({
      fileKind: "test",
      alphaStruct: 0,
      externalPassthroughCalls: 1,
      testMetrics: { providerId: "typescript-vitest" },
    });
    expect(impact.writeEntry.localBurdenFingerprint).toBeUndefined();
    expect(impact.writeEntry.previousLocalBurdenFingerprint).toBeUndefined();
  });
});
