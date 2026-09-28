import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ParserService, type QueryMatch } from "../../src/port/ParserService";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { RUST_CFG_RISK_QUERY } from "../../src/adapter/symbol-use/RustSymbolUseProvider";
import { captureOf } from "../../src/adapter/semantic-relations/semanticRelationShared";
import {
  ATTR_IDENTIFIER_QUERY,
  ATTR_SCOPED_QUERY,
  DECLARATION_QUERY,
  FIELD_QUERY,
  IMPL_QUERY,
  MACRO_QUERY,
  MODULE_QUERY,
  PARAMETER_QUERY,
  RETURN_QUERY,
  SOURCE_KINDS,
  STRUCT_EXPRESSION_QUERY,
  TARGET_KINDS,
  TRAIT_IMPL_QUERY,
  canonicalWorkspaceUri,
  collectRustImpls,
  collectRustWorkspaceRisks,
  declarationFor,
  declarationSymbol,
  declarationsFromRustMatches,
  implFor,
  implementsSourceKinds,
  moduleRangesFromMatches,
  pushRustDeclarationTargets,
  pushRustImplTargets,
  pushRustImplementsTargets,
  readCargoWorkspaceRisk,
  typeAnchorFor,
  type RelationCandidate,
  type RustDeclaration,
  type RustImpl,
} from "../../src/adapter/semantic-relations/RustSemanticSyntax";

/**
 * 行为特征化矩阵（characterization matrix）——锁定 Rust 语法映射层的**当前实际输出**。
 *
 * 这些期望值不是设计意图，而是重构前实现的实际观测值：由临时探针
 * `npx tsx packages/core/.probe-syntax-dump.ts` 打印 `JSON.stringify` 得到，
 * 探针已删除（原始输出见任务报告）。任何一条期望值发生变化都意味着
 * "Rust 语言映射"语义漂移，必须显式review，而不是顺手更新快照。
 *
 * 两条外部可观察约定被刻意记录：
 * - `typeAnchorFor` 取段判据是 `lastSeparator >= 0 ? head.slice(lastSeparator + 2) : head`。
 *   **缺陷与修复（2026-09-27）**：原实现无条件 `head.slice(lastSeparator + 2)`，无 `::` 时
 *   `lastSeparator === -1` ⇒ `slice(-1 + 2) = slice(1)`，静默切掉裸标识符首字符
 *   （`Request` → `equest`、`Self` → `elf`、`Result<u8>` 切 `<` 后 → `esult`）；同一个
 *   `+2` 还在 offset 上多加 1，使锚点落在该段内空白上（如 `"  &'static mut Vec<…>"` 的
 *   `Vec` 被定位到前一个空格）。旧实现里"名字丢首字符"与"offset 偏 1"是同一表达式
 *   的两个症状：正则 `…\s*$` 的 `match.index` 恰好补偿了裸标识符的 +1，所以只有名字可见地
 *   坏了；含 `::` 的路径不触发，故下游按 offset 定位长期"看起来正常"。修复即改为上式，
 *   名字与 offset 同时归位；`name` 的唯一生产消费者是 readiness 探针匹配（见下）。
 * - `canonicalWorkspaceUri` 在 win32 上整体小写；非 `file:` scheme 走 catch 分支，
 *   同样被小写。
 */

const FILE = "corpus.rs";

const parser = async () => Effect.runPromise(Effect.gen(function* () {
  return yield* ParserService;
}).pipe(Effect.provide(TreeSitterParserLive)));

const query = (p: ParserService, text: string, pattern: string) =>
  Effect.runPromise(p.queryText!(FILE, text, pattern).pipe(Effect.catchAll(() => Effect.succeed([] as QueryMatch[]))));

// ── 语料：来自探针的固定片段 ──────────────────────────────────────────────
const DECLARATIONS_SNIPPET = [
  "pub struct Alpha { pub a: u8 }",
  "enum Beta { One, Two }",
  "trait Gamma { fn g(&self); }",
  "mod outer {",
  "    pub struct Inner { pub x: u8 }",
  "    mod nested {",
  "        pub enum Deep { Yes }",
  "    }",
  "}",
  "impl Alpha { fn ctor() -> Self { Alpha { a: 0 } } }",
  "impl Gamma for Alpha { fn g(&self) {} }",
].join("\n");

const IMPLS_SNIPPET = [
  "struct Local { a: u8 }",
  "impl Local { fn make() -> Local { Local { a: 1 } } }",
  "impl Display for Local { fn fmt(&self) {} }",
  "impl crate::foreign::Foreign for Local { fn f(&self) {} }",
  "impl<T> Local { fn generic(v: T) {} }",
].join("\n");

const ANCHORS_SNIPPET = [
  "struct Holder {",
  "    plain: Request,",
  "    by_ref: &Request,",
  "    by_ref_lifetime: &'a mut Request,",
  "    vec: Vec<u8>,",
  "    opt_box: Option<Box<Request>>,",
  "    path: crate::foo::Bar<T>,",
  "    dyn_trait: Box<dyn Service>,",
  "    tuple: (Request, u8),",
  "    array: [Request; 4],",
  "    bare_dyn: dyn Service,",
  "    impl_trait: impl Service,",
  "    never: !,",
  "    underscore: _,",
  "    scoped_ty: <T as Iterator>::Item,",
  "}",
  "fn params(a: Request, b: &'a str, c: Vec<Response>, d: Option<Box<State>>) -> Response { Response { body: 1 } }",
  "fn ret() -> crate::foo::Bar<T> { todo!() }",
  "fn inst() -> Local { let x = Local { a: 1 }; let y = crate::m::Thing { b: 2 }; let z = Vec::new(); x }",
].join("\n");

const MACROS_AND_ATTRIBUTES_SNIPPET = [
  "#[derive(Debug, Clone)]",
  "#[serde::Serialize]",
  "#[cfg(test)]",
  "macro_rules! make { () => {}; }",
  "make!();",
  "#[plain_ident]",
  "struct WithAttrs { #[scoped::attr] field: Request }",
].join("\n");

const CFG_SNIPPET = ["struct A { a: u8 }", "#[cfg(feature = \"x\")]", "struct B { b: u8 }"].join("\n");

describe("rust semantic-relation syntax mapping (characterization)", () => {
  it("pins the query strings that define the language surface", () => {
    expect({
      DECLARATION_QUERY, MODULE_QUERY, IMPL_QUERY, TRAIT_IMPL_QUERY, FIELD_QUERY,
      PARAMETER_QUERY, RETURN_QUERY, STRUCT_EXPRESSION_QUERY, MACRO_QUERY,
      ATTR_IDENTIFIER_QUERY, ATTR_SCOPED_QUERY,
    }).toEqual({
      DECLARATION_QUERY: "[(struct_item name: (type_identifier) @name) @struct (enum_item name: (type_identifier) @name) @enum (trait_item name: (type_identifier) @name) @trait]",
      MODULE_QUERY: "(mod_item name: (identifier) @modName body: (declaration_list) @modBody)",
      IMPL_QUERY: "(impl_item type: (_) @typeRef) @impl",
      TRAIT_IMPL_QUERY: "(impl_item trait: (_) @traitRef type: (_) @typeRef) @impl",
      FIELD_QUERY: "(field_declaration name: (field_identifier) @fieldName type: (_) @typeRef)",
      PARAMETER_QUERY: "(function_item parameters: (parameters (parameter type: (_) @typeRef)))",
      RETURN_QUERY: "(function_item return_type: (_) @typeRef)",
      STRUCT_EXPRESSION_QUERY: "(struct_expression name: (type_identifier) @typeRef)",
      MACRO_QUERY: "(macro_invocation) @macro",
      ATTR_IDENTIFIER_QUERY: "(attribute_item (attribute (identifier) @name))",
      ATTR_SCOPED_QUERY: "(attribute_item (attribute (scoped_identifier) @name))",
    });
  });

  it("pins the fact-kind → symbol-kind tables", () => {
    expect(SOURCE_KINDS).toEqual(["struct", "enum", "trait"]);
    expect(implementsSourceKinds).toEqual(["struct", "enum"]);
    expect(TARGET_KINDS).toEqual({
      implements: ["trait"],
      field_type: ["struct", "enum", "trait"],
      parameter_type: ["struct", "enum", "trait"],
      return_type: ["struct", "enum", "trait"],
      instantiates: ["struct"],
      extends: [],
      embeds: [],
    });
  });

  it("maps lifetimes, references, generics and path types to a type anchor", () => {
    const anchorAt1000 = (text: string) => typeAnchorFor("-".repeat(500), { name: "typeRef", text, startIndex: 1000, endIndex: 1000 + text.length });
    // 期望值来源：修复后的 `typeAnchorFor` 实测输出，且逐条由"name 必须与 text 在 startIndex
    // 处的同长切片逐字相等"这一独立不变量复核（见本文件 offset 不变量用例，0 违例）。
    const cases: readonly (readonly [string, { name: string; startIndex: number } | undefined])[] = [
      // 裸标识符（曾丢首字符）：`Request`/`Self`/`u8` 是缺陷最直接的可见面。
      ["Request", { name: "Request", startIndex: 1000 }],
      ["Self", { name: "Self", startIndex: 1000 }],
      ["u8", { name: "u8", startIndex: 1000 }],
      ["x", { name: "x", startIndex: 1000 }],
      // 泛型：在首个 `<` 处截断，保留类型名本身。
      ["Vec<Request>", { name: "Vec", startIndex: 1000 }],
      ["Vec<u8>", { name: "Vec", startIndex: 1000 }],
      ["Result<u8, E>", { name: "Result", startIndex: 1000 }],
      ["Result<u8>", { name: "Result", startIndex: 1000 }],
      ["Option<Box<Request>>", { name: "Option", startIndex: 1000 }],
      ["Option<Result<Vec<Request>, E>>", { name: "Option", startIndex: 1000 }],
      ["Request<", { name: "Request", startIndex: 1000 }],
      ["Result<Request, Error>", { name: "Result", startIndex: 1000 }],
      ["Box<dyn Service>", { name: "Box", startIndex: 1000 }],
      // 作用域路径：取最后一个 `::` 之后的一段，offset 指向该段的真实首字符。
      ["crate::a::B", { name: "B", startIndex: 1010 }],
      ["crate::foo::Bar<T>", { name: "Bar", startIndex: 1012 }],
      ["a::b::c::Deep", { name: "Deep", startIndex: 1009 }],
      ["self::x::Y", { name: "Y", startIndex: 1009 }],
      ["Foo::Bar", { name: "Bar", startIndex: 1005 }],
      ["std::collections::HashMap<String, Request>", { name: "HashMap", startIndex: 1018 }],
      // 引用 / 生命周期 / mut 解包后的 offset 与解包字符数一致。
      ["&Request", { name: "Request", startIndex: 1001 }],
      ["&&Request", { name: "Request", startIndex: 1002 }],
      ["&mut Request", { name: "Request", startIndex: 1005 }],
      ["&'a mut Request", { name: "Request", startIndex: 1008 }],
      ["&'static str", { name: "str", startIndex: 1009 }],
      ["&mut Vec<Request>", { name: "Vec", startIndex: 1005 }],
      // 裸指针。
      ["*const Request", { name: "Request", startIndex: 1007 }],
      ["*mut Request", { name: "Request", startIndex: 1005 }],
      // 前导空白：offset 指向跳过空白后的名字首字符，不是空白本身。
      ["  Request  ", { name: "Request", startIndex: 1002 }],
      ["\t Self \t", { name: "Self", startIndex: 1002 }],
      ["  &'static mut Vec<Request>  ", { name: "Vec", startIndex: 1015 }],
      [" \t &'de \t mut Box<Vec<E \t >> ", { name: "Box", startIndex: 1014 }],
      // 结构形态与裸关键词：无法命名仓库类型，一律 undefined。
      ["(Request, u8)", undefined],
      ["(A, B)", undefined],
      ["[Request; 4]", undefined],
      ["[A; 4]", undefined],
      ["dyn Service", undefined],
      ["dyn T", undefined],
      ["impl Service", undefined],
      ["impl T", undefined],
      ["!", undefined],
      ["_", undefined],
      ["_Private", undefined],
      ["&[Request]", undefined],
      ["&[A]", undefined],
      ["*mut [A; 4]", undefined],
      ["<T as Iterator>::Item", undefined],
      ["fn(Request)", undefined],
      ["fn() -> Request", undefined],
      ["()", undefined],
      ["Foo::", undefined],
      ["self", { name: "self", startIndex: 1000 }],
      ["", undefined],
      ["   ", undefined],
    ];
    for (const [text, expected] of cases) expect({ text, anchor: anchorAt1000(text) }).toEqual({ text, anchor: expected });
    // 缺少 offset 时不可判定，不猜测。
    expect(typeAnchorFor("x", { name: "typeRef", text: "Request" })).toBeUndefined();
    expect(typeAnchorFor("x", { name: "typeRef", text: "Request", startIndex: 5 })).toBeUndefined();
    expect(typeAnchorFor("x", { name: "typeRef", text: "Request", endIndex: 5 })).toBeUndefined();
  });

  it("keeps the anchor name and its offset on the same character (bare-identifier defect regression)", () => {
    // 缺陷：无 `::` 时 `head.slice(lastSeparator + 2)` 退化为 `slice(1)`，名字丢首字符，
    // 且 offset 多加 1。回归断言同时锁定 `name` 与 `startIndex`：对每个命中锚点，
    // `text` 从 `startIndex`（相对 1000）起、长度等于 `name.length` 的切片必须逐字等于 `name`。
    const capture = (text: string) => ({ name: "typeRef", text, startIndex: 1000, endIndex: 1000 + text.length });
    const anchorAt = (text: string) => typeAnchorFor("-".repeat(500), capture(text));
    const corpus = [
      // 曾经丢首字符的裸标识符 / Self / 泛型（期望名现在是完整名字）
      "Request", "Self", "u8", "Vec<Request>", "Result<u8, E>", "Result<u8>",
      // 路径（本就不丢字符，不能回退）
      "crate::a::B", "a::b::c::Deep", "std::collections::HashMap<String, Request>",
      // 前导空白 / 引用 / 裸指针
      "  Request  ", "\t Self \t", "&'a mut Request", "*const Request", "*mut Request",
      "  &'static mut Vec<Request>  ", " \t &'de \t mut Box<Vec<E \t >> ",
    ];
    expect(corpus.map((text) => anchorAt(text)?.name)).toEqual([
      "Request", "Self", "u8", "Vec", "Result", "Result",
      "B", "Deep", "HashMap",
      "Request", "Self", "Request", "Request", "Request",
      "Vec", "Box",
    ]);
    expect(corpus.map((text) => anchorAt(text)?.startIndex)).toEqual([
      1000, 1000, 1000, 1000, 1000, 1000,
      1010, 1009, 1018,
      1002, 1002, 1008, 1007, 1005,
      1015, 1014,
    ]);
    for (const text of corpus) {
      const anchor = anchorAt(text)!;
      expect({ text, atOffset: text.slice(anchor.startIndex - 1000, anchor.startIndex - 1000 + anchor.name.length) })
        .toEqual({ text, atOffset: anchor.name });
    }
    // 结构形态在修复后仍不可命名仓库类型，不得因为"顺手"而开始猜测。
    for (const text of ["(A, B)", "[A; 4]", "dyn T", "impl T", "!", "_"]) {
      expect({ text, anchor: anchorAt(text) }).toEqual({ text, anchor: undefined });
    }
  });

  it("derives module ranges and qualified names for nested mods", async () => {
    const p = await parser();
    const matches = await query(p, DECLARATIONS_SNIPPET, MODULE_QUERY);
    expect(moduleRangesFromMatches(matches)).toEqual([
      { name: "outer", startLine: 4, endLine: 9 },
      { name: "nested", startLine: 6, endLine: 8 },
    ]);
  });

  it("maps a struct/enum/trait declaration set with module qualification", async () => {
    const p = await parser();
    const moduleRanges = moduleRangesFromMatches(await query(p, DECLARATIONS_SNIPPET, MODULE_QUERY));
    const declarations = declarationsFromRustMatches(FILE, await query(p, DECLARATIONS_SNIPPET, DECLARATION_QUERY), moduleRanges);
    expect(declarations.map(({ file, name, kind, qualifiedName, startLine, endLine }) => ({ file, name, kind, qualifiedName, startLine, endLine }))).toEqual([
      { file: FILE, name: "Alpha", kind: "struct", qualifiedName: "Alpha", startLine: 1, endLine: 1 },
      { file: FILE, name: "Beta", kind: "enum", qualifiedName: "Beta", startLine: 2, endLine: 2 },
      { file: FILE, name: "Gamma", kind: "trait", qualifiedName: "Gamma", startLine: 3, endLine: 3 },
      { file: FILE, name: "Inner", kind: "struct", qualifiedName: "outer::Inner", startLine: 5, endLine: 5 },
      { file: FILE, name: "Deep", kind: "enum", qualifiedName: "outer::nested::Deep", startLine: 7, endLine: 7 },
    ]);
    expect(declarations.map((declaration) => declarationSymbol(declaration, FILE))).toEqual([
      { id: "rust:repository:corpus.rs:Alpha", name: "Alpha", kind: "struct", scope: "repository", file: FILE, line: 1 },
      { id: "rust:repository:corpus.rs:Beta", name: "Beta", kind: "enum", scope: "repository", file: FILE, line: 2 },
      { id: "rust:repository:corpus.rs:Gamma", name: "Gamma", kind: "trait", scope: "repository", file: FILE, line: 3 },
      { id: "rust:repository:corpus.rs:outer::Inner", name: "Inner", kind: "struct", scope: "repository", file: FILE, line: 5 },
      { id: "rust:repository:corpus.rs:outer::nested::Deep", name: "Deep", kind: "enum", scope: "repository", file: FILE, line: 7 },
    ]);
  });

  it("classifies local, trait, foreign-trait and generic impls", async () => {
    const p = await parser();
    const impls = collectRustImpls(FILE, await query(p, IMPLS_SNIPPET, IMPL_QUERY), await query(p, IMPLS_SNIPPET, TRAIT_IMPL_QUERY));
    expect(impls.map((impl) => ({ startLine: impl.startLine, endLine: impl.endLine, type: impl.typeRef.text, trait: impl.traitRef?.text ?? null }))).toEqual([
      { startLine: 2, endLine: 2, type: "Local", trait: null },
      { startLine: 3, endLine: 3, type: "Local", trait: "Display" },
      { startLine: 4, endLine: 4, type: "Local", trait: "crate::foreign::Foreign" },
      { startLine: 5, endLine: 5, type: "Local", trait: null },
    ]);
  });

  it("maps field, parameter, return and instantiation candidates", async () => {
    const p = await parser();
    const text = ANCHORS_SNIPPET;
    const declarations = declarationsFromRustMatches(FILE, await query(p, text, DECLARATION_QUERY), []);
    const impls = collectRustImpls(FILE, await query(p, text, IMPL_QUERY), await query(p, text, TRAIT_IMPL_QUERY));
    const structDeclarations = declarations.filter((declaration) => declaration.kind === "struct");
    const enclosingStruct = (line: number) => declarationFor(structDeclarations, FILE, line);
    const enclosingImpl = (line: number) => implFor(impls, FILE, line);
    const candidates: RelationCandidate[] = [];
    pushRustDeclarationTargets(candidates, FILE, text, await query(p, text, FIELD_QUERY), "field_type", (m) => enclosingStruct(captureOf(m, "typeRef")?.startLine ?? -1));
    pushRustImplTargets(candidates, FILE, text, await query(p, text, PARAMETER_QUERY), "parameter_type", (m) => enclosingImpl(captureOf(m, "typeRef")?.startLine ?? -1));
    pushRustImplTargets(candidates, FILE, text, await query(p, text, RETURN_QUERY), "return_type", (m) => enclosingImpl(captureOf(m, "typeRef")?.startLine ?? -1));
    pushRustImplTargets(candidates, FILE, text, await query(p, text, STRUCT_EXPRESSION_QUERY), "instantiates", (m) => enclosingImpl(captureOf(m, "typeRef")?.startLine ?? -1));
    pushRustImplementsTargets(candidates, FILE, text, impls, await query(p, text, TRAIT_IMPL_QUERY));
    expect(declarations.map(({ name, kind, startLine, endLine }) => ({ name, kind, startLine, endLine }))).toEqual([
      { name: "Holder", kind: "struct", startLine: 1, endLine: 16 },
    ]);
    // 复合类型（tuple/array/dyn/impl/!）与 struct 声明之外的返回位置不产生候选。
    // 候选名同为修复后的完整类型名（此前 `equest`/`ec`/`ption`/`ox` 是被切掉首字符的同一缺陷）。
    expect(candidates.map((candidate) => `${candidate.kind}@L${candidate.line}:${candidate.target.name}`)).toEqual([
      "field_type@L2:Request",
      "field_type@L3:Request",
      "field_type@L4:Request",
      "field_type@L5:Vec",
      "field_type@L6:Option",
      "field_type@L7:Bar",
      "field_type@L8:Box",
    ]);
  });

  it("ignores struct expressions outside an impl and keeps impl-owned instantiations", async () => {
    const p = await parser();
    const text = IMPLS_SNIPPET;
    const impls = collectRustImpls(FILE, await query(p, text, IMPL_QUERY), await query(p, text, TRAIT_IMPL_QUERY));
    const candidates: RelationCandidate[] = [];
    const enclosingImpl = (line: number) => implFor(impls, FILE, line);
    pushRustImplTargets(candidates, FILE, text, await query(p, text, RETURN_QUERY), "return_type", (m) => enclosingImpl(captureOf(m, "typeRef")?.startLine ?? -1));
    pushRustImplTargets(candidates, FILE, text, await query(p, text, STRUCT_EXPRESSION_QUERY), "instantiates", (m) => enclosingImpl(captureOf(m, "typeRef")?.startLine ?? -1));
    pushRustImplementsTargets(candidates, FILE, text, impls, await query(p, text, TRAIT_IMPL_QUERY));
    expect(candidates.map((candidate) => `${candidate.kind}@L${candidate.line}:${candidate.target.name}`)).toEqual([
      "return_type@L2:Local",
      "instantiates@L2:Local",
      "implements@L3:Display",
      "implements@L4:Foreign",
    ]);
    // 泛型参数 `T` 无法命名仓库类型：`impl<T> Local { fn generic(v: T) {} }` 不产生参数候选。
    expect(implFor(impls, FILE, 5)?.typeRef.text).toBe("Local");
  });

  it("keeps macro and attribute captures observable but produces no candidates for them", async () => {
    const p = await parser();
    const text = MACROS_AND_ATTRIBUTES_SNIPPET;
    expect((await query(p, text, MACRO_QUERY)).length).toBeGreaterThan(0);
    // `#[serde::Serialize]` 是 scoped_identifier，只被 ATTR_SCOPED_QUERY 命中；
    // ATTR_IDENTIFIER_QUERY 只看到裸标识符属性（`serde` 不在其中）。
    expect((await query(p, text, ATTR_IDENTIFIER_QUERY)).map((m) => captureOf(m, "name")?.text)).toEqual(["derive", "cfg", "plain_ident"]);
    // 两个 scoped 属性：`#[serde::Serialize]` 与 `#[scoped::attr]`。
    expect((await query(p, text, ATTR_SCOPED_QUERY)).length).toBe(2);
    const declarations = declarationsFromRustMatches(FILE, await query(p, text, DECLARATION_QUERY), []);
    const candidates: RelationCandidate[] = [];
    pushRustDeclarationTargets(candidates, FILE, text, await query(p, text, FIELD_QUERY), "field_type", () => declarations[0]);
    expect(declarations.map(({ name, startLine }) => ({ name, startLine }))).toEqual([{ name: "WithAttrs", startLine: 7 }]);
    expect(candidates.map((candidate) => `${candidate.kind}@L${candidate.line}:${candidate.target.name}`)).toEqual(["field_type@L7:Request"]);
  });

  it("treats #[cfg] as a syntax fact only through the shared query", async () => {
    const p = await parser();
    expect(await query(p, CFG_SNIPPET, RUST_CFG_RISK_QUERY)).not.toHaveLength(0);
    const declarations = declarationsFromRustMatches(FILE, await query(p, CFG_SNIPPET, DECLARATION_QUERY), []);
    expect(declarations.map(({ name, startLine }) => ({ name, startLine }))).toEqual([{ name: "A", startLine: 1 }, { name: "B", startLine: 3 }]);
  });

  it("resolves enclosing declaration / impl ranges by inclusive line bounds", () => {
    const declaration: RustDeclaration = { file: FILE, name: "N", kind: "struct", qualifiedName: "N", startLine: 2, endLine: 4, startIndex: 10 };
    const impl: RustImpl = { file: FILE, startLine: 2, endLine: 4, typeRef: { name: "typeRef", text: "N" } };
    const expected = [-1, 0, 1, 2, 5, 99].map((line) => ({ line, inRange: line >= 2 && line <= 4 }));
    for (const { line, inRange } of expected) {
      expect({ line, found: declarationFor([declaration], FILE, line)?.name }).toEqual({ line, found: inRange ? "N" : undefined });
      expect({ line, found: Boolean(implFor([impl], FILE, line)) }).toEqual({ line, found: inRange });
      expect(declarationFor([declaration], "other.rs", line)).toBeUndefined();
      expect(implFor([impl], "other.rs", line)).toBeUndefined();
    }
  });

  it("reads Cargo workspace risk from the manifest only", () => {
    const dir = mkdtempSync(join(tmpdir(), "rust-syntax-mapping-"));
    try {
      const manifest = (name: string, content: string) => { const path = join(dir, name); writeFileSync(path, content, "utf8"); return path; };
      expect(readCargoWorkspaceRisk(manifest("plain.toml", "[package]\nname = \"x\"\nversion = \"0.1.0\"\n"))).toBeUndefined();
      expect(readCargoWorkspaceRisk(manifest("empty.toml", ""))).toBeUndefined();
      expect(readCargoWorkspaceRisk(manifest("bad.toml", "[package\nname = \"x\"\n"))).toBeUndefined();
      expect(readCargoWorkspaceRisk(manifest("deps.toml", "[dependencies]\nserde = \"1\"\n"))).toBeUndefined();
      expect(readCargoWorkspaceRisk(manifest("comment.toml", "# [workspace]\n[package]\nname = \"x\"\n"))).toBeUndefined();
      const workspaceRisk = "Cargo workspace manifests are outside the calibrated single-crate semantic-relations scope";
      expect(readCargoWorkspaceRisk(manifest("ws.toml", "[workspace]\nmembers = [\"a\", \"b\"]\n"))).toBe(workspaceRisk);
      expect(readCargoWorkspaceRisk(manifest("virtual.toml", "[workspace]\nresolver = \"2\"\n"))).toBe(workspaceRisk);
      expect(readCargoWorkspaceRisk(manifest("indent.toml", "  [workspace]\nmembers = []\n"))).toBe(workspaceRisk);
      expect(readCargoWorkspaceRisk(join(dir, "nope.toml"))).toBe("Rust Cargo.toml could not be read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collects manifest, topology and build-script workspace risks", () => {
    const dir = mkdtempSync(join(tmpdir(), "rust-workspace-risks-"));
    try {
      const crate = join(dir, "crate");
      mkdirSync(crate, { recursive: true });
      writeFileSync(join(crate, "Cargo.toml"), "[package]\nname = \"crate\"\nversion = \"0.1.0\"\n", "utf8");
      writeFileSync(join(crate, "build.rs"), "fn main() {}\n", "utf8");
      expect(collectRustWorkspaceRisks(crate, ["build.rs", "src/lib.rs"]))
        .toEqual(["Rust build scripts are outside the calibrated semantic-relations scope"]);
      expect(collectRustWorkspaceRisks(crate, ["src/lib.rs"])).toEqual([]);
      expect(collectRustWorkspaceRisks(join(dir, "nocargo"), ["src/lib.rs"]))
        .toEqual(["Rust semantic relations require a Cargo.toml crate rooted at the governed project"]);
      const workspace = join(dir, "workspace-crate");
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, "Cargo.toml"), "[workspace]\nmembers = [\"a\"]\n", "utf8");
      expect(collectRustWorkspaceRisks(workspace, ["build.rs"]))
        .toEqual([
          "Cargo workspace manifests are outside the calibrated single-crate semantic-relations scope",
          "Rust build scripts are outside the calibrated semantic-relations scope",
        ]);
      expect(collectRustWorkspaceRisks(workspace, ["src/lib.rs"]))
        .toEqual(["Cargo workspace manifests are outside the calibrated single-crate semantic-relations scope"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("canonicalizes workspace URIs and returns non-file schemes unchanged", () => {
    const lower = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    expect(canonicalWorkspaceUri("https://example.com/Case/Path.rs")).toBe(lower("https://example.com/Case/Path.rs"));
    expect(canonicalWorkspaceUri("untitled:Untitled-1")).toBe(lower("untitled:Untitled-1"));
    expect(canonicalWorkspaceUri("file://")).toBe(lower("file://"));
    const repoRoot = fileURLToPath(new URL("../../src/adapter/semantic-relations/RustSemanticRelationProvider.ts", import.meta.url));
    const fileUri = pathToFileURL(repoRoot).href;
    const canonical = canonicalWorkspaceUri(fileUri);
    expect(canonical.startsWith("file:///")).toBe(true);
    expect(canonicalWorkspaceUri(fileUri)).toBe(canonical);
    if (process.platform === "win32") expect(canonical).toBe(canonical.toLowerCase());
    const percentEncoded = pathToFileURL(join(import.meta.dirname, "a b")).href;
    expect(percentEncoded).toContain("%20");
    expect(canonicalWorkspaceUri(percentEncoded)).toBe(percentEncoded.toLowerCase());
  });
});
