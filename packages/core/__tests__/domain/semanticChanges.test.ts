import { describe, expect, it } from "vitest";
import { analyzeSemanticChanges } from "../../src/domain/semanticChanges";
import type { FileAst } from "../../src/domain/ast";

const ast = (overrides: Partial<FileAst>): FileAst => ({
  path: "src/api.ts",
  language: "typescript",
  branchCount: 0,
  nestingDepth: 0,
  functionCount: 0,
  passthroughCalls: 0,
  imports: [],
  functions: [],
  semanticSurface: { declarations: [], unsupportedTopLevel: [] },
  ...overrides,
});

describe("analyzeSemanticChanges", () => {
  it("splits one file into contract, body, and dependency change units", () => {
    const before = ast({
      imports: [{ source: "./old", resolvedPath: null }],
      semanticSurface: {
        unsupportedTopLevel: [],
        declarations: [
          { id: "Api.value", kind: "field", isPublic: true, signature: "value: string" },
          { id: "run", kind: "function", isPublic: true, signature: "function run(): void", body: "{ old(); }" },
        ],
      },
    });
    const after = ast({
      imports: [{ source: "./next", resolvedPath: null }],
      semanticSurface: {
        unsupportedTopLevel: [],
        declarations: [
          { id: "Api.value", kind: "field", isPublic: true, signature: "value: number" },
          { id: "run", kind: "function", isPublic: true, signature: "function run(): void", body: "{ next(); }" },
        ],
      },
    });

    expect(analyzeSemanticChanges(before, after)).toEqual({
      availability: "available",
      changes: expect.arrayContaining([
        { anchor: "Api.value", kind: "field_add_remove" },
        { anchor: "run", kind: "function_body" },
        { anchor: "import:./old", kind: "dependency_remove" },
        { anchor: "import:./next", kind: "dependency_add" },
      ]),
    });
  });

  it("counts a new interface once instead of multiplying its members", () => {
    const after = ast({
      semanticSurface: {
        unsupportedTopLevel: [],
        declarations: [
          { id: "Api", kind: "interface", isPublic: true, signature: "interface Api", body: "{ id: string }" },
          { id: "Api.id", kind: "field", isPublic: true, signature: "id: string" },
        ],
      },
    });
    expect(analyzeSemanticChanges(undefined, after)).toEqual({
      availability: "available",
      changes: [{ anchor: "Api", kind: "interface_add_remove" }],
    });
  });

  it("does not double-count a class body when a member already explains the delta", () => {
    const before = ast({
      semanticSurface: { declarations: [
        { id: "Client", kind: "class", isPublic: true, signature: "class Client", body: "{ value: string }" },
        { id: "Client.value", kind: "field", isPublic: true, signature: "value: string" },
      ], unsupportedTopLevel: [] },
    });
    const after = ast({
      semanticSurface: { declarations: [
        { id: "Client", kind: "class", isPublic: true, signature: "class Client", body: "{ value: number }" },
        { id: "Client.value", kind: "field", isPublic: true, signature: "value: number" },
      ], unsupportedTopLevel: [] },
    });
    expect(analyzeSemanticChanges(before, after)).toEqual({
      availability: "available",
      changes: [{ anchor: "Client.value", kind: "field_add_remove" }],
    });
  });

  it("keeps private module bindings in the implementation tier", () => {
    const after = ast({
      semanticSurface: { declarations: [
        { id: "helper", kind: "field", isPublic: false, signature: "const helper = () => true" },
        { id: "internalType", kind: "interface", isPublic: false, signature: "interface internalType" },
      ], unsupportedTopLevel: [] },
    });
    expect(analyzeSemanticChanges(undefined, after)).toEqual({
      availability: "available",
      changes: [
        { anchor: "helper", kind: "function_body" },
        { anchor: "internalType", kind: "function_body" },
      ],
    });
  });

  it("keeps legal type/value names distinct while rejecting same-kind ambiguity", () => {
    const before = ast({
      semanticSurface: { unsupportedTopLevel: [], declarations: [
        { id: "Token", kind: "interface", isPublic: true, signature: "interface Token" },
        { id: "Token", kind: "field", isPublic: true, signature: "const Token = makeTag()" },
      ] },
    });
    const after = ast({
      semanticSurface: { unsupportedTopLevel: [], declarations: [
        { id: "Token", kind: "interface", isPublic: true, signature: "interface Token" },
        { id: "Token", kind: "field", isPublic: true, signature: "const Token = makeNextTag()" },
      ] },
    });

    expect(analyzeSemanticChanges(before, after)).toEqual({
      availability: "available",
      changes: [{ anchor: "Token", kind: "field_add_remove" }],
    });
  });

  it("keeps a stable public name when it moves to a re-export and reports its dependency", () => {
    const before = ast({
      semanticSurface: { unsupportedTopLevel: [], declarations: [
        { id: "collect", kind: "field", isPublic: true, signature: "const collect = () => []" },
      ] },
      imports: [],
    });
    const after = ast({
      semanticSurface: { unsupportedTopLevel: [], declarations: [
        { id: "collect", kind: "function", isPublic: true, provenance: "reexport", signature: "collect" },
      ] },
      imports: [{ source: "./transport", resolvedPath: null }],
    });

    expect(analyzeSemanticChanges(before, after)).toEqual({
      availability: "available",
      changes: [{ anchor: "import:./transport", kind: "dependency_add" }],
    });
  });

  it("classifies a public arrow implementation edit as a function body change", () => {
    const before = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "run", kind: "function", isPublic: true, signature: "export const run = () =>", body: "{ old(); }" },
    ] } });
    const after = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "run", kind: "function", isPublic: true, signature: "export const run = () =>", body: "{ next(); }" },
    ] } });

    expect(analyzeSemanticChanges(before, after)).toEqual({
      availability: "available",
      changes: [{ anchor: "run", kind: "function_body" }],
    });
  });

  it("keeps an additive optional contract field distinct from a breaking field change", () => {
    const before = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "Options", kind: "interface", isPublic: true, signature: "interface Options", body: "{}" },
    ] } });
    const after = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "Options", kind: "interface", isPublic: true, signature: "interface Options", body: "{ trace?: string }" },
      { id: "Options.trace", kind: "field", isPublic: true, contractCompatibility: "additive", signature: "trace?: string" },
    ] } });

    expect(analyzeSemanticChanges(before, after)).toEqual({
      availability: "available",
      changes: [{ anchor: "Options.trace", kind: "compatible_field_add" }],
    });
  });

  it("keeps changed unclassified top-level syntax unavailable", () => {
    const before = ast({ semanticSurface: { declarations: [], unsupportedTopLevel: ["macro:legacy!"] } });
    const after = ast({ semanticSurface: { declarations: [], unsupportedTopLevel: ["macro:next!"] } });
    expect(analyzeSemanticChanges(before, after)).toEqual({
      availability: "unavailable",
      changes: [],
      reason: "changed top-level syntax has no semantic classifier",
    });
  });

  it("classifies supported declarations in an added file despite unclassified top-level boilerplate", () => {
    const after = ast({
      semanticSurface: {
        unsupportedTopLevel: ["package_declaration:package fixture"],
        declarations: [{ id: "ToolSupport", kind: "class", isPublic: true, signature: "class ToolSupport" }],
      },
    });
    expect(analyzeSemanticChanges(undefined, after)).toEqual({
      availability: "available",
      changes: [{ anchor: "ToolSupport", kind: "class_add_remove" }],
    });
  });
});
