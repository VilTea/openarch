import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { ParserService } from "../../src/port/ParserService";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

const parse = (path: string) => Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* parser.parse(path);
});

describe("JavaStrategy", () => {
  it("resolves conventional Maven source imports and shares structural facts", () => withTemporaryDirectory("parse-java", async (dir) => {
    const sourceRoot = join(dir, "src", "main", "java", "demo");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(dir, "pom.xml"), "<project />");
    const helper = join(sourceRoot, "Helper.java");
    const sample = join(sourceRoot, "Sample.java");
    writeFileSync(helper, "package demo; public class Helper { public void ping() {} }");
    writeFileSync(sample, [
      "package demo;", "import demo.Helper;", "import external.Client;", "public class Sample {",
      "  public void run(Helper helper, Client client) {",
      "    if (helper == null) { return; }", "    helper.ping(); client.send(); externalCall();", "  }", "}",
    ].join("\n"));
    const ast = await Effect.runPromise(parse(sample).pipe(Effect.provide(TreeSitterParserLive)));
    expect(ast.language).toBe("java");
    expect(ast.imports.find((entry) => entry.source === "demo.Helper")?.resolvedPath).toBe(helper.replace(/\\/g, "/"));
    expect(ast.imports.find((entry) => entry.source === "external.Client")?.resolvedPath).toBeNull();
    expect(ast.maxFuncBranch).toBeCloseTo(0.3, 5);
    expect(ast.passthroughCalls).toBe(3);
    expect(ast.externalPassthroughCalls).toBe(1);
    expect(ast.exportedSymbols).toEqual([{ name: "run", kind: "function" }]);
    expect(ast.semanticSurface?.declarations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Sample", kind: "class", isPublic: true }),
      expect.objectContaining({ id: "Sample.run", kind: "function", isPublic: true }),
    ]));
  }));

  it("extracts fully-qualified package references without import statements (JUnit-style)", () => withTemporaryDirectory("parse-java-fq", async (dir) => {
    const sourceRoot = join(dir, "src", "main", "java", "demo");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(dir, "pom.xml"), "<project />");
    const assertFile = join(sourceRoot, "Assert.java");
    const consumer = join(sourceRoot, "Consumer.java");
    writeFileSync(assertFile, "package demo; public class Assert { public static void ok() {} }");
    // 全限定调用（org.junit.Assert.assertTrue 风格，无 import）应解析到 Assert.java；
    // 首段大写的类型引用（MyType.Inner）不得误当包路径。
    writeFileSync(consumer, [
      "package demo;", "public class Consumer {",
      "  public void run() { demo.Assert.ok(); MyType.Inner field = new MyType.Inner(); }", "}",
    ].join("\n"));
    const ast = await Effect.runPromise(parse(consumer).pipe(Effect.provide(TreeSitterParserLive)));
    const assertImports = ast.imports.filter((entry) => entry.source === "demo.Assert");
    expect(assertImports.length).toBeGreaterThan(0);
    expect(assertImports.every((entry) => entry.resolvedPath === assertFile.replace(/\\/g, "/"))).toBe(true);
    // MyType.Inner 首段大写 → 不作为包路径依赖提取
    expect(ast.imports.some((entry) => entry.source === "MyType.Inner")).toBe(false);
  }));
});
