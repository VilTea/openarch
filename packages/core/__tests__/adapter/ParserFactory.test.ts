import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ParserService } from "../../src/port/ParserService";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { LANGUAGE_SUPPORTS } from "../../src/languageSupport";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

// GenericTag 必须先 yield* 拿到 service 实例，再调用其方法（不能 ParserService.parse 直调）
const parseVia = (path: string) =>
  Effect.gen(function* () {
    const service = yield* ParserService;
    return yield* service.parse(path);
  });

const parseTextVia = (path: string, text: string) =>
  Effect.gen(function* () {
    const service = yield* ParserService;
    return yield* service.parseText(path, text);
  });

describe("TreeSitterParserLive (TsStrategy)", () => {
  it("uses the same language registry for public metadata and parser routing", async () => {
    const supported = await Effect.runPromise(
      Effect.gen(function* () {
        const parser = yield* ParserService;
        return yield* parser.supportedLanguages;
      }).pipe(Effect.provide(TreeSitterParserLive)),
    );

    expect(supported).toEqual(LANGUAGE_SUPPORTS.map((language) => language.id));
  });

  it("serializes concurrent grammar initialization", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      Effect.runPromise(
        parseTextVia("parallel.py", "def sample():\n    return 1\n").pipe(Effect.provide(TreeSitterParserLive)),
      ),
    ));

    expect(results.every((ast) => ast.language === "python")).toBe(true);
  });

  it("解析 TS 文件得 branchCount + imports", () => withTemporaryDirectory("parse", async (dir) => {
    const helperPath = join(dir, "helper.ts");
    const mainPath = join(dir, "main.ts");
    writeFileSync(helperPath, "export const x = 1;");
    writeFileSync(mainPath, 'import { x } from "./helper";\nif (x) { console.log(1); }');

    const ast = await Effect.runPromise(
      parseVia(mainPath).pipe(Effect.provide(TreeSitterParserLive))
    );
    expect(ast.branchCount).toBeGreaterThanOrEqual(1);
    expect(ast.imports.some((i) => i.source === "./helper")).toBe(true);
    expect(ast.imports.find((i) => i.source === "./helper")?.resolvedPath).toBe(helperPath);

  }));

  it("解析 JS 文件时也按同一注册表解析 import 后缀", () => withTemporaryDirectory("parse-js", async (dir) => {
    const helperPath = join(dir, "helper.js");
    const mainPath = join(dir, "main.js");
    writeFileSync(helperPath, "export const x = 1;");
    writeFileSync(mainPath, 'import { x } from "./helper";\nif (x) { console.log(1); }');

    const ast = await Effect.runPromise(
      parseVia(mainPath).pipe(Effect.provide(TreeSitterParserLive))
    );
    expect(ast.language).toBe("javascript");
    expect(ast.imports.find((i) => i.source === "./helper")?.resolvedPath).toBe(helperPath);

  }));

  it("在内存文本中复用同一 TS import 解析策略", () => withTemporaryDirectory("parse-text", async (dir) => {
    const helperPath = join(dir, "helper.ts");
    const mainPath = join(dir, "main.ts");
    writeFileSync(helperPath, "export const helper = true;\n");

    const ast = await Effect.runPromise(
      parseTextVia(mainPath, 'import { helper } from "./helper";\nexport const value = helper;\n').pipe(Effect.provide(TreeSitterParserLive)),
    );

    expect(ast.imports).toEqual([{ source: "./helper", resolvedPath: helperPath }]);
  }));

  it("区分 TS 文件总加权分支、单函数最大分支与顶层分派", () => withTemporaryDirectory("branch-ts", async (dir) => {
    const mainPath = join(dir, "main.ts");
    writeFileSync(mainPath, [
      "if (process.env.DEBUG) console.log('debug');",
      "function worker(value: string | null) {",
      "  if (!value) return;",
      "  if (value === 'ok') console.log(value);",
      "}",
    ].join("\n"));

    const ast = await Effect.runPromise(parseVia(mainPath).pipe(Effect.provide(TreeSitterParserLive)));
    expect(ast.weightedBranchTotal).toBeCloseTo(2.3, 5);
    expect(ast.branchCount).toBeCloseTo(ast.weightedBranchTotal ?? 0, 5);
    expect(ast.maxFuncBranch).toBeCloseTo(1.3, 5);
    expect(ast.topLevelWeightedBranch).toBeCloseTo(1, 5);

  }));

  it("按既有权重计入 TS switch 的 case 与 default", () => withTemporaryDirectory("switch-ts", async (dir) => {
    const mainPath = join(dir, "main.ts");
    writeFileSync(mainPath, [
      "function worker(value: string) {",
      "  switch (value) { case 'a': return; default: return; }",
      "}",
    ].join("\n"));

    const ast = await Effect.runPromise(parseVia(mainPath).pipe(Effect.provide(TreeSitterParserLive)));
    expect(ast.weightedBranchTotal).toBeCloseTo(1.6, 5);
    expect(ast.maxFuncBranch).toBeCloseTo(1.6, 5);

  }));

  it("提取 TS 的本地导出函数，忽略非函数导出", () => withTemporaryDirectory("exports-ts", async (dir) => {
    const mainPath = join(dir, "main.ts");
    writeFileSync(mainPath, "export function named() {}\nexport const arrow = () => true;\nexport const value = 1;\n");

    const ast = await Effect.runPromise(parseVia(mainPath).pipe(Effect.provide(TreeSitterParserLive)));
    expect(ast.exportedSymbols).toEqual([{ name: "arrow", kind: "function" }, { name: "named", kind: "function" }]);

  }));

  it("提取 TS 的声明级语义事实，供 revision diff 复用", async () => {
    const ast = await Effect.runPromise(
      parseTextVia("semantic.ts", [
        "export interface Api { value: string; run(value: string): void; }",
        "export class Client { public name: string; run(): void { console.log(this.name); } }",
      ].join("\n")).pipe(Effect.provide(TreeSitterParserLive)),
    );

    expect(ast.semanticSurface?.declarations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Api", kind: "interface", isPublic: true }),
      expect.objectContaining({ id: "Api.value", kind: "field", isPublic: true }),
      expect.objectContaining({ id: "Api.run", kind: "function", isPublic: true }),
      expect.objectContaining({ id: "Client", kind: "class", isPublic: true }),
      expect.objectContaining({ id: "Client.name", kind: "field", isPublic: true }),
      expect.objectContaining({ id: "Client.run", kind: "function", isPublic: true }),
    ]));
    expect(ast.semanticSurface?.unsupportedTopLevel).toEqual([]);
  });

  it("将具名 TS re-export 表达为公共语义单元", async () => {
    const ast = await Effect.runPromise(
      parseTextVia("barrel.ts", 'export { publicApi as api } from "./api";').pipe(Effect.provide(TreeSitterParserLive)),
    );
    expect(ast.semanticSurface?.declarations).toEqual([
      expect.objectContaining({ id: "api", kind: "function", isPublic: true, provenance: "reexport" }),
    ]);
    expect(ast.imports).toEqual(expect.arrayContaining([expect.objectContaining({ source: "./api", relation: "reexport" })]));
    expect(ast.semanticSurface?.unsupportedTopLevel).toEqual([]);
  });

  it("keeps an exported arrow function's contract separate from its body", async () => {
    const ast = await Effect.runPromise(
      parseTextVia("api.ts", "export const run = (value: string) => { return value.trim(); };").pipe(Effect.provide(TreeSitterParserLive)),
    );
    expect(ast.semanticSurface?.declarations).toEqual([
      expect.objectContaining({ id: "run", kind: "function", isPublic: true, signature: "const run = (value: string) =>" }),
    ]);
  });

  it("marks an optional TS contract field as an additive extension", async () => {
    const ast = await Effect.runPromise(
      parseTextVia("options.ts", "export interface Options { readonly trace?: string; }").pipe(Effect.provide(TreeSitterParserLive)),
    );
    expect(ast.semanticSurface?.declarations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Options.trace", kind: "field", contractCompatibility: "additive" }),
    ]));
  });

  it("expresses a named Rust pub use as the same re-export declaration fact", async () => {
    const ast = await Effect.runPromise(
      parseTextVia("reexport.rs", "pub use crate::api::Thing as PublicThing;").pipe(Effect.provide(TreeSitterParserLive)),
    );
    expect(ast.semanticSurface?.declarations).toEqual([
      expect.objectContaining({ id: "PublicThing", kind: "function", isPublic: true, provenance: "reexport" }),
    ]);
    expect(ast.imports).toEqual(expect.arrayContaining([expect.objectContaining({ source: "crate::api::Thing as PublicThing", relation: "reexport" })]));
  });

  it("为 Go 与 Rust 提供同一声明事实合同", async () => {
    const [go, rust] = await Promise.all([
      Effect.runPromise(parseTextVia("semantic.go", "package sample\ntype Api interface { Run() }\nfunc Public() {}\n").pipe(Effect.provide(TreeSitterParserLive))),
      Effect.runPromise(parseTextVia("semantic.rs", "pub trait Api { fn run(); }\npub fn public() {}\n").pipe(Effect.provide(TreeSitterParserLive))),
    ]);

    expect(go.semanticSurface?.declarations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Api", kind: "interface", isPublic: true }),
      expect.objectContaining({ id: "Public", kind: "function", isPublic: true }),
    ]));
    expect(go.semanticSurface?.unsupportedTopLevel).toEqual([]);
    expect(rust.semanticSurface?.declarations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Api", kind: "interface", isPublic: true }),
      expect.objectContaining({ id: "public", kind: "function", isPublic: true }),
    ]));
    expect(rust.semanticSurface?.unsupportedTopLevel).toEqual([]);
  });

  it("以 receiver 类型区分 Go 的同名方法声明", async () => {
    const ast = await Effect.runPromise(
      parseTextVia("methods.go", [
        "package sample",
        "type First struct{}",
        "type Second struct{}",
        "func (First) Validate() {}",
        "func (*Second) Validate() {}",
      ].join("\n")).pipe(Effect.provide(TreeSitterParserLive)),
    );

    expect(ast.semanticSurface?.declarations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "First.Validate", kind: "function", isPublic: true }),
      expect.objectContaining({ id: "Second.Validate", kind: "function", isPublic: true }),
    ]));
    const identities = ast.semanticSurface?.declarations.map((declaration) => `${declaration.id}\u0000${declaration.kind}`) ?? [];
    expect(new Set(identities).size).toBe(identities.length);
  });

  it("不支持的扩展名 → ParseError", async () => {
    // 用 Effect.either 把 error channel 包成 Either，避免 runPromise reject 出 Cause
    const either = await Effect.runPromise(
      parseVia("foo.unknown").pipe(Effect.provide(TreeSitterParserLive), Effect.either)
    );
    expect(either._tag).toBe("Left");
    if (either._tag === "Left") {
      expect(either.left._tag).toBe("ParseError");
    }
  });

  it("解析 Go 文件得 language + branchCount + module-local imports", () => withTemporaryDirectory("parse-go", async (dir) => {
    mkdirSync(join(dir, "internal", "helper"), { recursive: true });
    writeFileSync(join(dir, "go.mod"), "module example.com/demo\n\ngo 1.26.0\n");
    const helperPath = join(dir, "internal", "helper", "helper.go");
    const mainPath = join(dir, "main.go");
    writeFileSync(helperPath, "package helper\n\nfunc Ping() int { return 1 }\n");
    writeFileSync(mainPath, [
      "package main",
      "",
      "import \"example.com/demo/internal/helper\"",
      "",
      "func main() {",
      "\tif helper.Ping() > 0 {",
      "\t\tprintln(\"ok\")",
      "\t}",
      "}",
      "func Public() {}",
      "",
    ].join("\n"));

    const ast = await Effect.runPromise(
      parseVia(mainPath).pipe(Effect.provide(TreeSitterParserLive))
    );

    expect(ast.language).toBe("go");
    expect(ast.branchCount).toBeGreaterThanOrEqual(1);
    expect(ast.imports.some((entry) => entry.source === "example.com/demo/internal/helper")).toBe(true);
    expect(ast.imports.find((entry) => entry.source === "example.com/demo/internal/helper")?.resolvedPath).toBe(helperPath.replace(/\\/g, "/"));
    expect(ast.exportedSymbols).toEqual([{ name: "Public", kind: "function" }]);

  }));

  it("按 TS 相同权重拆分 Go 的函数控制流与顶层分派", () => withTemporaryDirectory("branch-go", async (dir) => {
    const mainPath = join(dir, "main.go");
    writeFileSync(mainPath, [
      "package main",
      "func init() {",
      "  if true { println(\"top\") }",
      "}",
      "func worker(value string) {",
      "  if value == \"\" { return }",
      "  if value == \"ok\" { println(value) }",
      "}",
    ].join("\n"));

    const ast = await Effect.runPromise(parseVia(mainPath).pipe(Effect.provide(TreeSitterParserLive)));
    expect(ast.weightedBranchTotal).toBeCloseTo(2.3, 5);
    expect(ast.maxFuncBranch).toBeCloseTo(1.3, 5);
    expect(ast.topLevelWeightedBranch).toBe(0);

  }));

  it("TS 与 Go 都让嵌套函数拥有独立的函数分支事实", async () => {
    const fixtures = [
      {
        extension: "ts",
        source: [
          "function outer() {",
          "  if (true) {}",
          "  const inner = () => { if (false) {} };",
          "  inner();",
          "}",
        ].join("\n"),
        names: ["outer", "inner"],
      },
      {
        extension: "go",
        source: [
          "package main",
          "func outer() {",
          "  if true {}",
          "  func() { if false {} }()",
          "}",
        ].join("\n"),
        names: ["outer", "(anonymous)"],
      },
    ] as const;

    for (const fixture of fixtures) {
      await withTemporaryDirectory(`nested-${fixture.extension}`, async (dir) => {
      const filePath = join(dir, `nested.${fixture.extension}`);
      writeFileSync(filePath, fixture.source);

      const ast = await Effect.runPromise(parseVia(filePath).pipe(Effect.provide(TreeSitterParserLive)));
      expect(ast.weightedBranchTotal).toBeCloseTo(2, 5);
      expect(ast.maxFuncBranch).toBeCloseTo(1, 5);
      expect(ast.functions.map((fn) => fn.name)).toEqual(fixture.names);
      expect(ast.functions.map((fn) => fn.branchCount)).toEqual([1, 1]);

      });
    }
  });

  it("所有已支持语言只将可确认的直接非本地调用计入 CRL 外部调用", async () => {
    const fixtures = [
      {
        extension: "ts",
        source: "function helper() {}\nfunction run() { helper(); helper(); externalOne(); externalTwo(); client.send(); }",
      },
      {
        extension: "go",
        source: "package sample\nfunc helper() {}\nfunc run() { helper(); helper(); externalOne(); externalTwo(); client.Send() }",
      },
      {
        extension: "rs",
        source: "fn helper() {}\nfn run() { helper(); helper(); external_one(); external_two(); client.send(); }",
      },
      {
        extension: "py",
        source: "def helper(): pass\ndef run():\n    helper()\n    helper()\n    external_one()\n    external_two()\n    client.send()\n",
      },
    ] as const;

    for (const fixture of fixtures) {
      const ast = await Effect.runPromise(
        parseTextVia(`external-calls.${fixture.extension}`, fixture.source).pipe(Effect.provide(TreeSitterParserLive)),
      );
      expect(ast.passthroughCalls).toBe(5);
      expect(ast.externalPassthroughCalls).toBe(2);
    }
  });

  it("解析 Rust 的 Cargo 本地模块、函数事实和加权控制流", () => withTemporaryDirectory("parse-rust", async (dir) => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n");
    const helperPath = join(dir, "src", "helper.rs");
    const mainPath = join(dir, "src", "lib.rs");
    writeFileSync(helperPath, "pub fn ping() -> bool { true }\n");
    writeFileSync(mainPath, [
      "use crate::helper::ping;",
      "use std::collections::HashMap;",
      "pub fn worker(value: Option<String>) -> bool {",
      "  if value.is_none() { return false; }",
      "  let nested = || { if value.is_some() { true } else { false } };",
      "  match value { Some(_) => nested(), None => ping() }",
      "}",
    ].join("\n"));

    const ast = await Effect.runPromise(parseVia(mainPath).pipe(Effect.provide(TreeSitterParserLive)));

    expect(ast.language).toBe("rust");
    expect(ast.imports.find((entry) => entry.source === "crate::helper::ping")?.resolvedPath).toBe(helperPath.replace(/\\/g, "/"));
    expect(ast.imports.find((entry) => entry.source === "std::collections::HashMap")?.resolvedPath).toBeNull();
    expect(ast.weightedBranchTotal).toBeCloseTo(2.9, 5);
    expect(ast.maxFuncBranch).toBeCloseTo(1.9, 5);
    expect(ast.functions.map((fn) => fn.name)).toEqual(["worker", "nested"]);
    expect(ast.exportedSymbols).toEqual([{ name: "worker", kind: "function" }]);

  }));

  it("解析 Python 的项目内模块、外部 import 与公开函数", () => withTemporaryDirectory("parse-python", async (dir) => {
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "pyproject.toml"), "[project]\nname = 'demo'\nversion = '0.1.0'\n");
    writeFileSync(join(dir, "app", "__init__.py"), "");
    const helperPath = join(dir, "app", "helper.py");
    const mainPath = join(dir, "app", "main.py");
    writeFileSync(helperPath, "def ping() -> bool:\n    return True\n");
    writeFileSync(mainPath, [
      "from .helper import ping",
      "from external_package import value",
      "def public(value: str | None):",
      "    if value is None:",
      "        return ping()",
      "    return value",
      "def _private(): pass",
    ].join("\n"));

    const ast = await Effect.runPromise(parseVia(mainPath).pipe(Effect.provide(TreeSitterParserLive)));

    expect(ast.language).toBe("python");
    expect(ast.imports.find((entry) => entry.source === ".helper")?.resolvedPath).toBe(helperPath.replace(/\\/g, "/"));
    expect(ast.imports.find((entry) => entry.source === "external_package")?.resolvedPath).toBeNull();
    expect(ast.maxFuncBranch).toBeCloseTo(0.3, 5);
    expect(ast.exportedSymbols).toEqual([{ name: "public", kind: "function" }]);

  }));

  it("keeps Python nested functions separate and maps match cases to shared weights", async () => {
    const ast = await Effect.runPromise(parseTextVia("worker.py", [
      "def worker(value):",
      "    def nested():",
      "        if value: return 1",
      "        return 0",
      "    match value:",
      "        case 'a': return nested()",
      "        case _: return 0",
    ].join("\n")).pipe(Effect.provide(TreeSitterParserLive)));

    expect(ast.functions.map((fn) => fn.name)).toEqual(["worker", "nested"]);
    expect(ast.functions.map((fn) => fn.branchCount)).toEqual([1.6, 0.3]);
    expect(ast.maxFuncBranch).toBeCloseTo(1.6, 5);
  });

  it("provides Python declaration facts without inventing dynamic import edges", async () => {
    const ast = await Effect.runPromise(parseTextVia("semantic.py", [
      "import importlib",
      "class Client:",
      "    value = 1",
      "    def run(self): return self.value",
      "def public(): return importlib.import_module('dynamic')",
    ].join("\n")).pipe(Effect.provide(TreeSitterParserLive)));

    expect(ast.imports).toEqual([{ source: "importlib", resolvedPath: null }]);
    expect(ast.semanticSurface?.declarations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Client", kind: "class", isPublic: true }),
      expect.objectContaining({ id: "Client.value", kind: "field", isPublic: true }),
      expect.objectContaining({ id: "Client.run", kind: "function", isPublic: true }),
      expect.objectContaining({ id: "public", kind: "function", isPublic: true }),
    ]));
    expect(ast.semanticSurface?.unsupportedTopLevel).toEqual([]);
  });

  it("keeps an empty Python package module inside the baseline LOC contract", async () => {
    const ast = await Effect.runPromise(
      parseTextVia("__init__.py", "").pipe(Effect.provide(TreeSitterParserLive)),
    );

    expect(ast.loc).toBe(1);
    expect(ast.imports).toEqual([]);
    expect(ast.functions).toEqual([]);
  });
});
