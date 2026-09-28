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

  it("classifies removed declarations when after is undefined (deleted file)", () => {
    const before = ast({
      semanticSurface: {
        unsupportedTopLevel: [],
        declarations: [
          { id: "Legacy", kind: "class", isPublic: true, signature: "class Legacy" },
          { id: "Legacy.run", kind: "field", isPublic: true, signature: "run()" },
        ],
      },
    });
    expect(analyzeSemanticChanges(before, undefined)).toEqual({
      availability: "available",
      changes: [{ anchor: "Legacy", kind: "class_add_remove" }],
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

  it("classifies changed unclassified top-level syntax as function_body when no other units exist", () => {
    const before = ast({ semanticSurface: { declarations: [], unsupportedTopLevel: ["macro:legacy!"] } });
    const after = ast({ semanticSurface: { declarations: [], unsupportedTopLevel: ["macro:next!"] } });
    expect(analyzeSemanticChanges(before, after)).toEqual({
      availability: "available",
      changes: [{ anchor: "file:top-level", kind: "function_body" }],
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

  /**
   * 重载身份设计（缺陷 2026-09-25，Java 重载 ⇒ 永久不可分类）：
   * 身份按 (id, kind) → (id, kind, 参数个数) → (id, kind, 完整签名) 逐级细化，
   * 只在**同一层内仍有重载冲突**时才细化。下面钉住这一取舍的每一面。
   */
  it("disambiguates overloads by parameter count instead of refusing the whole file", () => {
    const before = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "fill", kind: "function", isPublic: true, signature: "public void fill(int a)", body: "{ }" },
      { id: "untouched", kind: "function", isPublic: true, signature: "public void untouched()", body: "{ }" },
    ] } });
    const after = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "fill", kind: "function", isPublic: true, signature: "public void fill(int a)", body: "{ }" },
      { id: "fill", kind: "function", isPublic: true, signature: "public void fill(int a, int b)", body: "{ }" },
      { id: "untouched", kind: "function", isPublic: true, signature: "public void untouched()", body: "{ }" },
    ] } });

    // 元数层足够区分：新增的 2 参重载被报告为一次新增，原有 1 参重载与无关方法不受影响。
    expect(analyzeSemanticChanges(before, after)).toEqual({
      availability: "available",
      changes: [{ anchor: "fill", kind: "public_method_sig" }],
    });
  });

  it("classifies an unrelated edit in a file that merely contains overloads", () => {
    const before = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "Svc.fill", kind: "function", isPublic: true, signature: "public void fill(int a)", body: "{ }" },
      { id: "Svc.fill", kind: "function", isPublic: true, signature: "public void fill(int a, int b)", body: "{ }" },
      { id: "Svc.untouched", kind: "function", isPublic: true, signature: "public void untouched()", body: "{ old(); }" },
    ] } });
    const after = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "Svc.fill", kind: "function", isPublic: true, signature: "public void fill(int a)", body: "{ }" },
      { id: "Svc.fill", kind: "function", isPublic: true, signature: "public void fill(int a, int b)", body: "{ }" },
      { id: "Svc.untouched", kind: "function", isPublic: true, signature: "public void untouched()", body: "{ next(); }" },
    ] } });

    expect(analyzeSemanticChanges(before, after)).toEqual({
      availability: "available",
      changes: [{ anchor: "Svc.untouched", kind: "function_body" }],
    });
  });

  it("keeps a parameter type change a single modified declaration when identity is unambiguous", () => {
    const before = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "fill", kind: "function", isPublic: true, signature: "public void fill(int a)", body: "{ }" },
    ] } });
    const after = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "fill", kind: "function", isPublic: true, signature: "public void fill(long a)", body: "{ }" },
    ] } });

    expect(analyzeSemanticChanges(before, after)).toEqual({
      availability: "available",
      changes: [{ anchor: "fill", kind: "public_method_sig" }],
    });
  });

  it("fails closed and names every competing signature when one side has two unpaired overloads", () => {
    const declarations = (types: readonly string[]): FileAst => ast({ semanticSurface: { unsupportedTopLevel: [], declarations: types.map((type) => ({
      id: "fill", kind: "function" as const, isPublic: true, signature: `public void fill(${type} a)`, body: "{ }",
    })) } });

    const analysis = analyzeSemanticChanges(declarations(["int", "long"]), declarations(["short"]));
    // before 剩两个、after 剩一个：语法无法指出 `short` 对应 `int` 还是 `long`（也可能两个都删了）。
    // 保留 unknown，并把冲突事实（id + 全部竞争签名 + 建议类别）命名出来交给 --change-override。
    expect(analysis).toEqual({
      availability: "unavailable",
      changes: [],
      reason: "declaration identities are ambiguous: fill has 3 competing signatures (public void fill(int a) | public void fill(long a) | public void fill(short a))",
      ambiguity: {
        id: "fill",
        signatures: ["public void fill(int a)", "public void fill(long a)", "public void fill(short a)"],
        suggestedKind: "public_method_sig",
      },
    });
  });

  it("pins the overload trade-off: a single in-set parameter type change is one modified declaration", () => {
    const before = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "fill", kind: "function", isPublic: true, signature: "public void fill(int a)", body: "{ }" },
      { id: "fill", kind: "function", isPublic: true, signature: "public void fill(long a)", body: "{ }" },
    ] } });
    const after = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "fill", kind: "function", isPublic: true, signature: "public void fill(short a)", body: "{ }" },
      { id: "fill", kind: "function", isPublic: true, signature: "public void fill(long a)", body: "{ }" },
    ] } });

    // 取舍显式化：`long` 精确配对，两侧各剩一个（int / short）⇒ 认定为"同一声明改了参数类型"，
    // 报一个 public_method_sig，而不是要求人工 override。反向选择（fail-closed）会让
    // "函数改一个参数类型"这种最常见的变更重新变成人工负担——那正是本次要修的缺陷。
    // 代价：若实际上是"删 int、加 short"两笔，这里会少报一笔；两者都是破坏性公共合同变化，
    // 对本仓库的影响路由等价。
    expect(analyzeSemanticChanges(before, after)).toEqual({
      availability: "available",
      changes: [{ anchor: "fill", kind: "public_method_sig" }],
    });
  });

  it("reports an added same-arity overload instead of failing closed", () => {
    const before = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "fill", kind: "function", isPublic: true, signature: "public void fill(int a)", body: "{ }" },
    ] } });
    const after = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "fill", kind: "function", isPublic: true, signature: "public void fill(int a)", body: "{ }" },
      { id: "fill", kind: "function", isPublic: true, signature: "public void fill(long a)", body: "{ }" },
    ] } });

    // 两侧签名集合有一侧被包含（[int] ⊂ [int, long]）：int 对齐，多出来的 long 是纯新增。
    // 这正是重载文件不再永久不可分类的地方。
    expect(analyzeSemanticChanges(before, after)).toEqual({
      availability: "available",
      changes: [{ anchor: "fill", kind: "public_method_sig" }],
    });
  });

  it("keeps a body edit reported as a body change when the parameter list is unparsable", () => {
    const before = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "run", kind: "function", isPublic: true, signature: "export const run = () =>", body: "{ old(); }" },
    ] } });
    const after = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "run", kind: "function", isPublic: true, signature: "export const run = () =>", body: "{ next(); }" },
    ] } });

    // 参数列表不可解析 ⇒ **不猜元数**；但该 (id, kind) 两版各只有一个声明，身份唯一，
    // 签名也没变而体变了 ⇒ function_body，与改造前一致。
    expect(analyzeSemanticChanges(before, after)).toEqual({
      availability: "available",
      changes: [{ anchor: "run", kind: "function_body" }],
    });
  });

  it("treats an unparsable signature rewrite as one modified declaration when it is the only candidate", () => {
    const before = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "run", kind: "function", isPublic: true, signature: "export const run = () =>", body: "{ old(); }" },
    ] } });
    const after = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "run", kind: "function", isPublic: true, signature: "export const run = max(1, 2) && go", body: "{ next(); }" },
    ] } });

    // 两侧各只剩这一个声明 ⇒ 身份唯一，按旧行为报"改了一个声明"。这里**不使用**参数元数
    // （`max(1, 2)` 是调用不是参数列表，元数启发式在此不可靠），但也**不必**fail-closed：
    // 唯一候选就是旧行为，block 整个文件反而是本次要修的人工负担。
    expect(analyzeSemanticChanges(before, after)).toEqual({
      availability: "available",
      changes: [{ anchor: "run", kind: "public_method_sig" }],
    });
  });

  it("collapses duplicate identical declarations instead of inventing a collision", () => {
    const before = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "fill", kind: "function", isPublic: true, signature: "public void fill(int a)", body: "{ }" },
    ] } });
    const after = ast({ semanticSurface: { unsupportedTopLevel: [], declarations: [
      { id: "fill", kind: "function", isPublic: true, signature: "public void fill(int a)", body: "{ }" },
      { id: "fill", kind: "function", isPublic: true, signature: "public void fill(int a)", body: "{ }" },
    ] } });

    // 签名完全相同 ⇒ 是同一声明被解析器重复上报，不是重载、更不是一次"新增"。
    // 折叠后两侧签名集合相等 ⇒ 没有任何声明级变化，落回保守的"无实质变化"结论。
    expect(analyzeSemanticChanges(before, after)).toEqual({
      availability: "available",
      changes: [{ anchor: "file", kind: "comment_whitespace" }],
    });
  });
});
