import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";import { queryJava } from "../../src/adapter/parser/JavaStrategy";
import { queryRust } from "../../src/adapter/parser/RustStrategy";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { collectGoSymbolUse, goSymbolUseProvider } from "../../src/adapter/symbol-use/GoSymbolUseProvider";
import { javaDefinition, javaSymbolUseProvider } from "../../src/adapter/symbol-use/JavaSymbolUseProvider";
import { rustDefinition, rustSymbolUseProvider, RUST_CFG_RISK_QUERY } from "../../src/adapter/symbol-use/RustSymbolUseProvider";
import type { LspSession } from "../../src/adapter/lsp/NodeLspSession";
import { ParseError } from "../../src/errors/errors";
import { ParserService } from "../../src/port/ParserService";

const roots: string[] = [];

const writeFixture = (extension: string, source: string): string => {
  const cwd = mkdtempSync(join(tmpdir(), "openarch-symbol-use-syntax-"));
  roots.push(cwd);
  const file = join(cwd, `fixture${extension}`);
  writeFileSync(file, source);
  return file;
};

/** Go 管线的 go.mod 锚点 + 单文件 fixture。 */
const goProject = (source: string): { readonly cwd: string; readonly file: string } => {
  const cwd = mkdtempSync(join(tmpdir(), "openarch-symbol-use-go-"));
  roots.push(cwd);
  writeFileSync(join(cwd, "go.mod"), "module fixture\n");
  const file = join(cwd, "fixture.go");
  writeFileSync(file, source);
  return { cwd, file };
};

/** 真实 ParserService：在带 Scope 的 Effect 里取一次，作为单例复用（WASM 只初始化一次）。 */
let sharedParser: ParserService | undefined;
const realParser = (): Promise<ParserService> => Effect.runPromise(Effect.gen(function* () {
  if (!sharedParser) sharedParser = yield* ParserService;
  return sharedParser;
}).pipe(Effect.provide(TreeSitterParserLive)));

const session = (): LspSession => ({
  notify: () => undefined,
  close: () => undefined,
  request: async (method) => method === "textDocument/references" ? [] as never
    : method === "initialize" ? { capabilities: { referencesProvider: true } } as never : {} as never,
});

/** 记录任何按路径读盘的查询（`query(path, ...)`）；`queryText` 原样透传。 */
const trackDiskReads = (parser: ParserService, reads: string[]): ParserService => new Proxy(parser, {
  get: (target, property, receiver) => {
    if (property === "query") {
      return (path: string, pattern: string) => {
        reads.push(path);
        return target.query(path, pattern);
      };
    }
    const value = Reflect.get(target, property, receiver) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  },
});


/** 走**真实** tree-sitter 语法：命中与否由查询决定，而不是由测试里的文本匹配决定。 */
const queryWith = (
  query: (path: string, pattern: string) => ReturnType<typeof queryJava>,
  file: string,
  pattern: string,
) => Effect.runPromise(query(file, pattern));

const captureTexts = (matches: readonly { readonly captures: readonly { readonly name: string; readonly text: string }[] }[], name: string): readonly string[] =>
  matches.flatMap((match) => match.captures.filter((capture) => capture.name === name).map((capture) => capture.text));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("symbol-use syntax risk detection (D5/D6/D11)", () => {
  it("only reports Java reflection when the method call exists in syntax", async () => {
    const file = writeFixture(".java", [
      "class Fixture {",
      "  // historical: Class.forName was removed",
      '  void mentions() { log("Class.forName not used"); }',
      "  void /* getDeclaredMethod */ real() throws Exception {",
      '    Class.forName("x");',
      '    this.getClass().getDeclaredMethod("y");',
      "    Method m = null;",
      "    m.invoke(this);",
      "  }",
      "}",
    ].join("\n"));
    const risk = javaDefinition.sourceRisks?.[0];
    expect(risk).toBeDefined();
    const matches = await queryWith(queryJava, file, risk!.pattern);
    // 真实反射调用被确认；注释与字符串里的提及不产生 `method_invocation`。
    expect([...captureTexts(matches, "name")].sort()).toEqual(["forName", "getDeclaredMethod", "invoke"]);
    expect(risk!.syntax(matches)).toBe(true);
  });

  it("does not report Java reflection for comment-only or string-only mentions", async () => {
    const file = writeFixture(".java", [
      "class Fixture {",
      "  // historical: Class.forName was removed",
      '  void f() { log("Class.forName not used"); }',
      "  /* getDeclaredMethod */",
      "}",
    ].join("\n"));
    const risk = javaDefinition.sourceRisks?.[0]!;
    const matches = await queryWith(queryJava, file, risk.pattern);
    expect(matches).toEqual([]);
    expect(risk.syntax(matches)).toBe(false);
  });

  it("only reports Rust conditional compilation for real attributes", async () => {
    const file = writeFixture(".rs", [
      "// #[cfg(test)] kept for reference",
      "#[cfg(test)]",
      "mod tests {}",
      '#[cfg_attr(feature = "x", derive(Debug))]',
      "struct S;",
    ].join("\n"));
    const risk = rustDefinition.sourceRisks?.[0];
    expect(risk).toBeDefined();
    const matches = await queryWith(queryRust as never, file, RUST_CFG_RISK_QUERY);
    // `cfg_attr` 不是 `cfg`：属性名比较必须精确。
    expect(captureTexts(matches, "name")).toEqual(["cfg"]);
    expect(risk!.syntax(matches)).toBe(true);
  });

  it("does not report Rust conditional compilation for a commented-out attribute", async () => {
    const file = writeFixture(".rs", [
      "// #[cfg(test)] kept for reference",
      "fn plain() {}",
    ].join("\n"));
    const risk = rustDefinition.sourceRisks?.[0]!;
    const matches = await queryWith(queryRust as never, file, RUST_CFG_RISK_QUERY);
    expect(matches).toEqual([]);
    expect(risk.syntax(matches)).toBe(false);
  });

  it("classifies a Java declaration whose visibility modifier is on another line", async () => {
    const file = writeFixture(".java", [
      "class Fixture {",
      "  public",
      "  void foo() {}",
      "}",
    ].join("\n"));
    const query = javaDefinition.declarationQueries.find((entry) => entry.kind === "function")!;
    const matches = await queryWith(queryJava, file, query.pattern);
    const modifiers = captureTexts(matches, "modifiers")[0] ?? "";
    expect(captureTexts(matches, "name")).toEqual(["foo"]);
    expect(modifiers).toBe("public");
    // 旧实现只看"名字同一行、名字之前"的文本（`void `）⇒ 误判 internal ⇒ 漏报公开面变更。
    expect(javaDefinition.isInternal({ name: "foo", modifiers, source: "", startIndex: 0 })).toBe(false);
  });

  it("keeps unmodified Java declarations internal and public ones declared-public", () => {
    const isInternal = (modifiers: string) => javaDefinition.isInternal({ name: "foo", modifiers, source: "", startIndex: 0 });
    expect(isInternal("")).toBe(true);
    expect(isInternal("private")).toBe(true);
    expect(isInternal("public")).toBe(false);
    expect(isInternal("protected")).toBe(false);
  });

  it("classifies a Rust declaration whose visibility modifier is on another line", async () => {
    const file = writeFixture(".rs", [
      "pub",
      "fn foo() {}",
    ].join("\n"));
    const query = rustDefinition.declarationQueries[0]!;
    const matches = await queryWith(queryRust as never, file, query.pattern);
    const modifiers = captureTexts(matches, "modifiers")[0] ?? "";
    expect(captureTexts(matches, "name")).toEqual(["foo"]);
    expect(modifiers).toBe("pub");
    // 旧实现只看"名字同一行、名字之前"的文本（`""`）⇒ 误判 internal。
    expect(rustDefinition.isInternal({ name: "foo", modifiers, source: "", startIndex: 0 })).toBe(false);
  });

  it("keeps crate-visible Rust declarations internal", () => {
    // 经 provider 的公开判定点覆盖同一张可见性表（helper 已收为模块私有）：
    // 无修饰符、`pub(crate)`、`pub(super)` 都是 crate 内可见 ⇒ internal；只有 `pub` 是公开面。
    const isInternal = (modifiers: string) => rustDefinition.isInternal({ name: "foo", modifiers, source: "", startIndex: 0 });
    expect(isInternal("")).toBe(true);
    expect(isInternal("pub(crate)")).toBe(true);
    expect(isInternal("pub(super)")).toBe(true);
    expect(isInternal("pub")).toBe(false);
  });

  it("wires the corrected predicates into the registered providers", () => {
    expect(javaSymbolUseProvider.id).toBe(javaDefinition.providerId);
    expect(rustSymbolUseProvider.id).toBe(rustDefinition.providerId);
    expect(goSymbolUseProvider.requiredToolchains).toContain("gopls");
    // sourceRisk 的判定通道只有语法查询；不存在接收整份源码文本的入口。
    expect(javaDefinition.sourceRisks?.[0]).not.toHaveProperty("detected");
    expect(rustDefinition.sourceRisks?.[0]).not.toHaveProperty("detected");
    expect(javaDefinition.sourceRisks?.[0]?.syntax).toBeTypeOf("function");
    expect(rustDefinition.sourceRisks?.[0]?.syntax).toBeTypeOf("function");
    // `queryRust`/`queryJava` 的公共签名与 port 兼容（编译期即可验证）。
    const portCompatible: ParserService["query"] = queryJava;
    expect(portCompatible).toBeTypeOf("function");
  });

  // ③ port 补 `queryText`：调用方已持有文本时不再读盘。
  it("parses caller-held text through the port even when the path does not exist", async () => {
    const source = "class Held { void real() { Class.forName(\"x\"); } }";
    const matches = await Effect.runPromise(Effect.gen(function* () {
      const parser = yield* ParserService;
      // 路径刻意不存在：一旦实现回退到读盘，这里必然抛错而不是返回命中。
      return yield* parser.queryText!("/nonexistent/Held.java", source, javaDefinition.sourceRisks![0]!.pattern);
    }).pipe(Effect.provide(TreeSitterParserLive)));
    expect(captureTexts(matches, "name")).toEqual(["forName"]);
  });
});

describe("symbol-use risk queries read the caller-held text through the port (③)", () => {
  it("produces the identical Rust #[cfg] capture set from held text and from the file", async () => {
    const file = writeFixture(".rs", [
      "// #[cfg(test)] kept for reference",
      "#[cfg(test)]",
      "mod tests {}",
    ].join("\n"));
    const [fromText, fromFile] = await Effect.runPromise(Effect.gen(function* () {
      const parser = yield* ParserService;
      return yield* Effect.all([
        parser.queryText!(file, readFileSync(file, "utf8"), RUST_CFG_RISK_QUERY),
        parser.query(file, RUST_CFG_RISK_QUERY),
      ]);
    }).pipe(Effect.provide(TreeSitterParserLive)));
    // 逐字不变：同一 pattern 在"已持有文本"与"按路径读盘"两条通道上给出同一捕获集合。
    expect(fromText).toEqual(fromFile);
    expect(captureTexts(fromText, "name")).toEqual(["cfg"]);
  });

  it("reads a Go file once and still reports the real build-constraint comment", async () => {
    const { cwd, file } = goProject([
      "//go:build linux",
      "",
      "package fixture",
      'var note = "//go:build windows"',
      "func Exported() {}",
    ].join("\n"));
    // 先读一次正文（真实管线也是先读后查）；此后所有查询都必须只吃这份文本。
    const source = readFileSync(file, "utf8");
    const diskReads: string[] = [];
    const parser = trackDiskReads(await realParser(), diskReads);
    const report = await Effect.runPromise(collectGoSymbolUse({ cwd, languages: ["go"] }, {
      parser,
      executable: "gopls",
      startSession: () => session(),
    }).pipe(Effect.provide(TreeSitterParserLive)));
    // 真实注释仍命中 build 约束风险；原始字符串里的 `"//go:build windows"` 是字符串节点，不参与。
    expect(report.state.reason).toContain("build constraints");
    expect(source).toContain("//go:build linux");
    expect(diskReads).toEqual([]);
  });

  it("does not report Go build constraints for a string literal mention", async () => {
    const { cwd } = goProject([
      "package fixture",
      'var note = "//go:build windows"',
      'var other = "// Code generated by mockgen. DO NOT EDIT."',
      "func Exported() {}",
    ].join("\n"));
    const diskReads: string[] = [];
    const parser = trackDiskReads(await realParser(), diskReads);
    const report = await Effect.runPromise(collectGoSymbolUse({ cwd, languages: ["go"] }, {
      parser,
      executable: "gopls",
      startSession: () => session(),
    }).pipe(Effect.provide(TreeSitterParserLive)));
    // 旧实现是整份文件上的行锚定正则，会把字符串字面量里的这两行当风险。
    expect(report.state.reason ?? "").not.toContain("build constraints");
    expect(report.state.reason ?? "").not.toContain("generated Go source");
    expect(diskReads).toEqual([]);
  });

  it("keeps the unknown state (not an empty risk set) when a parser cannot query held text", async () => {
    const { cwd } = goProject("package fixture\nfunc Exported() {}\n");
    // 只有 `query` 的假 parser：`queryText` 缺省，且 `query` 失败（权限/解析不可用）。
    // fail-closed 要求它表现为 incomplete，而不是"没有风险"。
    const parser: ParserService = {
      parse: () => Effect.die("not used"),
      parseText: () => Effect.die("not used"),
      query: () => Effect.fail(new ParseError({ path: "fixture.go", cause: new Error("unavailable") })),
      supportedLanguages: Effect.succeed(["go"]),
    };
    const report = await Effect.runPromise(collectGoSymbolUse({ cwd, languages: ["go"] }, {
      parser,
      executable: "gopls",
      startSession: () => session(),
    }));
    expect(report.state.coverage?.declarations).toBe("partial");
    expect(report.state.reason).toContain("parser declaration collection is incomplete");
  });
});
