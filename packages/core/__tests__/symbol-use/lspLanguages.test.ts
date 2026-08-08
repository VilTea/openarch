import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { collectGoSymbolUse } from "../../src/adapter/symbol-use/GoSymbolUseProvider";
import { collectJavaSymbolUse } from "../../src/adapter/symbol-use/JavaSymbolUseProvider";
import { collectRustSymbolUse } from "../../src/adapter/symbol-use/RustSymbolUseProvider";
import { collectPythonSymbolUse } from "../../src/adapter/symbol-use/PythonSymbolUseProvider";
import { queryGo } from "../../src/adapter/parser/GoStrategy";
import { queryJava } from "../../src/adapter/parser/JavaStrategy";
import { queryRust } from "../../src/adapter/parser/RustStrategy";
import { queryPython } from "../../src/adapter/parser/PythonStrategy";
import { semanticEvidenceView } from "../support/semanticEvidence";
import type { LspLaunchSpec, LspSession } from "../../src/adapter/lsp/NodeLspSession";
import type { ParserService } from "../../src/port/ParserService";

const roots: string[] = [];
const canonical = (path: string): string => realpathSync.native(path);

interface Case {
  readonly language: "go" | "rust" | "java";
  readonly extension: string;
  readonly source: string;
  readonly internal: string;
  readonly publicName: string;
  readonly collect: typeof collectGoSymbolUse | typeof collectRustSymbolUse | typeof collectJavaSymbolUse;
  readonly expectedArgs: readonly string[];
  readonly indicator: string;
  readonly query: (path: string, pattern: string) => ReturnType<typeof queryGo>;
  readonly declarationQuery: string;
}

const cases: readonly Case[] = [
  { language: "go", extension: ".go", source: "package fixture\nfunc hidden() {}\nfunc Exported() {}\n", internal: "hidden", publicName: "Exported", collect: collectGoSymbolUse, expectedArgs: ["-remote=auto"], indicator: "go.mod", query: queryGo, declarationQuery: "(function_declaration name: (identifier) @name)" },
  { language: "rust", extension: ".rs", source: "fn hidden() {}\npub fn exposed() {}\n", internal: "hidden", publicName: "exposed", collect: collectRustSymbolUse, expectedArgs: [], indicator: "Cargo.toml", query: queryRust, declarationQuery: "(function_item name: (identifier) @name)" },
  { language: "java", extension: ".java", source: "class Fixture { void hidden() {} public void exposed() {} }\n", internal: "hidden", publicName: "exposed", collect: collectJavaSymbolUse, expectedArgs: [], indicator: "pom.xml", query: queryJava, declarationQuery: "(method_declaration name: (identifier) @name)" },
];

const project = (entry: Case) => {
  const cwd = mkdtempSync(join(tmpdir(), `openarch-${entry.language}-symbol-use-`));
  roots.push(cwd);
  const directory = entry.language === "java" ? join(cwd, "src", "main", "java") : cwd;
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `fixture${entry.extension}`);
  writeFileSync(file, entry.source);
  writeFileSync(join(cwd, entry.indicator), "fixture");
  return { cwd, file };
};

const parserFor = (file: string, entry: Case): ParserService => ({
  parse: () => Effect.die("not used"),
  parseText: () => Effect.die("not used"),
  supportedLanguages: Effect.succeed([entry.language]),
  query: (path, pattern) => Effect.succeed(canonical(path) !== canonical(file) ? []
    : pattern.includes("scoped_identifier") && entry.source.includes("framework::entry") ? [{ captures: [{
      name: "name", text: "framework::entry", startLine: 1, startIndex: entry.source.indexOf("framework::entry"),
    }] }]
    : (entry.language === "java" ? pattern.includes("method_declaration")
      : entry.language === "go" ? pattern.includes("function_declaration")
        : pattern.includes("function_item")) ? [
      { captures: [{ name: "name", text: entry.internal, startLine: 2, startIndex: entry.source.indexOf(entry.internal) }] },
      { captures: [{ name: "name", text: entry.publicName, startLine: 3, startIndex: entry.source.indexOf(entry.publicName) }] },
    ] : []),
});

const session = (): LspSession => ({
  notify: () => undefined,
  close: () => undefined,
  request: async (method) => method === "textDocument/references" ? [] as never
    : method === "initialize" ? { capabilities: { referencesProvider: true } } as never : {} as never,
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("external language symbol-use providers", () => {
  it.each(cases)("uses a valid Tree-sitter declaration query for $language", async (entry) => {
    const { file } = project(entry);
    const matches = await Effect.runPromise(entry.query(file, entry.declarationQuery));
    expect(matches.flatMap((match) => match.captures.filter((capture) => capture.name === "name").map((capture) => capture.text)))
      .toEqual([entry.internal, entry.publicName]);
  });

  it.each(cases)("anchors internal and declared-public $language declarations with calibrated coverage boundaries", async (entry) => {
    const { cwd, file } = project(entry);
    const launches: LspLaunchSpec[] = [];
    const report = await Effect.runPromise(entry.collect({ cwd, languages: [entry.language] }, {
      parser: parserFor(file, entry),
      executable: `${entry.language}-server`,
      startSession: (launch) => { launches.push(launch); return session(); },
    }));

    if (entry.language === "java") {
      // java launch 携带稳定 -data（Eclipse workspace 目录，按 cwd hash）——动态值无法精确匹配
      expect(launches[0]!.command).toBe("java-server");
      expect(launches[0]!.args[0]).toBe("-data");
      expect(typeof launches[0]!.args[1]).toBe("string");
      expect(launches[0]!.args).toHaveLength(2);
    } else {
      expect(launches).toEqual([{
        command: `${entry.language}-server`,
        args: entry.expectedArgs,
        ...(entry.language === "go" ? { shutdown: "self" } : {}),
      }]);
    }
    expect(semanticEvidenceView(report)).toMatchObject({
      language: entry.language,
      availability: "available",
      coverage: { declarations: "complete", repositoryReferences: "complete" },
      scope: { mode: "repository", selectedDeclarationFileCount: 1, declarationFamilies: expect.arrayContaining(["callable"]) },
      facts: [
        { declaration: { name: entry.internal }, publicSurface: "internal", repositoryReferences: [] },
        { declaration: { name: entry.publicName }, publicSurface: "declared-public", repositoryReferences: [] },
      ],
    });
    expect(report.facts).toHaveLength(2);
    expect(report.state.reason).toBeUndefined();
  });

  it("treats crate-visible Rust declarations as internal", async () => {
    const entry = cases[1]!;
    const { cwd, file } = project({ ...entry, source: "pub(crate) fn hidden() {}\npub fn exposed() {}\n" });
    const report = await Effect.runPromise(entry.collect({ cwd, languages: ["rust"] }, {
      parser: parserFor(file, { ...entry, source: "pub(crate) fn hidden() {}\npub fn exposed() {}\n" }), executable: "rust-analyzer", startSession: () => session(),
    }));
    expect(report.facts.map((fact) => fact.declaration.name)).toEqual(["hidden", "exposed"]);
  });

  it("keeps Go references partial when workspace evidence exceeds its calibrated scope", async () => {
    const entry = cases[0]!;
    const { cwd, file } = project(entry);
    writeFileSync(join(cwd, "go.work"), "go 1.26\nuse .\n");
    const report = await Effect.runPromise(entry.collect({ cwd, languages: [entry.language] }, {
      parser: parserFor(file, entry), executable: "gopls", startSession: () => session(),
    }));

    expect(semanticEvidenceView(report)).toMatchObject({
      availability: "partial",
      coverage: { declarations: "complete", repositoryReferences: "partial" },
      reason: expect.stringContaining("workspace mode"),
    });
  });

  it("keeps Java references partial when Maven scope has external dependencies", async () => {
    const entry = cases[2]!;
    const { cwd, file } = project(entry);
    writeFileSync(join(cwd, "pom.xml"), "<project><dependencies><dependency /></dependencies></project>");
    const report = await Effect.runPromise(entry.collect({ cwd, languages: [entry.language] }, {
      parser: parserFor(file, entry), executable: "jdtls", startSession: () => session(),
    }));
    expect(semanticEvidenceView(report)).toMatchObject({
      availability: "partial",
      coverage: { declarations: "complete", repositoryReferences: "partial" },
      reason: expect.stringContaining("external dependencies"),
    });
  });

  it("keeps Rust declaration and reference coverage partial when a workspace member build script can generate source", async () => {
    const entry = cases[1]!;
    const { cwd, file } = project(entry);
    mkdirSync(join(cwd, "member"));
    writeFileSync(join(cwd, "member", "build.rs"), "fn main() {}\n");
    const report = await Effect.runPromise(entry.collect({ cwd, languages: [entry.language] }, {
      parser: parserFor(file, entry), executable: "rust-analyzer", startSession: () => session(),
    }));

    expect(semanticEvidenceView(report)).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      scope: { mode: "repository", selectedDeclarationFileCount: 2, declarationFamilies: expect.arrayContaining(["callable"]) },
      reason: expect.stringContaining("build scripts"),
    });
  });

  it("keeps Rust declaration and reference coverage partial for a path attribute macro", async () => {
    const entry = { ...cases[1]!, source: "#[framework::entry]\nfn hidden() {}\npub fn exposed() {}\n" };
    const { cwd, file } = project(entry);
    const report = await Effect.runPromise(entry.collect({ cwd, languages: [entry.language] }, {
      parser: parserFor(file, entry), executable: "rust-analyzer", startSession: () => session(),
    }));

    expect(semanticEvidenceView(report)).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      reason: expect.stringContaining("path attribute macros"),
    });
  });

  it("does not treat a server without reference capability as an empty reference result", async () => {
    const entry = cases[0]!;
    const { cwd, file } = project(entry);
    const report = await Effect.runPromise(entry.collect({ cwd, languages: [entry.language] }, {
      parser: parserFor(file, entry), executable: "gopls", startSession: () => ({
        notify: () => undefined,
        close: () => undefined,
        request: async () => ({} as never),
      }),
    }));

    expect(semanticEvidenceView(report)).toMatchObject({
      availability: "unavailable",
      coverage: { declarations: "unavailable", repositoryReferences: "unavailable" },
      reason: expect.stringContaining("did not advertise"),
    });
  });

  it("distributes a bounded reference budget across declaration files", async () => {
    const entry = cases[0]!;
    const { cwd } = project(entry);
    const alpha = join(cwd, "alpha.go");
    const beta = join(cwd, "beta.go");
    const gamma = join(cwd, "gamma.go");
    const sourceFor = (prefix: string, count: number) => `package fixture\n${Array.from({ length: count }, (_, index) => `func ${prefix}${index}() {}\n`).join("")}`;
    const sourceInputs = [
      [alpha, sourceFor("alpha", 202)],
      [beta, sourceFor("beta", 1)],
      [gamma, sourceFor("gamma", 1)],
    ] as const;
    for (const [file, source] of sourceInputs) writeFileSync(file, source);
    const sources = new Map(sourceInputs.map(([file, source]) => [canonical(file), source]));
    const parser: ParserService = {
      parse: () => Effect.die("not used"),
      parseText: () => Effect.die("not used"),
      supportedLanguages: Effect.succeed(["go"]),
      query: (file, pattern) => {
        const source = sources.get(canonical(file));
        if (!source || !pattern.includes("function_declaration")) return Effect.succeed([]);
        return Effect.succeed([...source.matchAll(/func (\w+)\(\)/g)].map((match) => ({ captures: [{
          name: "name", text: match[1]!, startIndex: match.index! + 5,
          startLine: source.slice(0, match.index! + 5).split("\n").length,
        }] })));
      },
    };
    const requestedFiles = new Set<string>();
    const report = await Effect.runPromise(collectGoSymbolUse({ cwd, languages: ["go"] }, {
      parser,
      executable: "gopls",
      startSession: () => ({
        notify: () => undefined,
        close: () => undefined,
        request: async (method, params) => {
          if (method === "initialize") return { capabilities: { referencesProvider: true } } as never;
          if (method === "textDocument/references") {
            requestedFiles.add((params as { textDocument: { uri: string } }).textDocument.uri);
          }
          return [] as never;
        },
      }),
    }));

    expect(report.facts).toHaveLength(200);
    expect(report.state.reason).toContain("reference request budget reached (200)");
    expect(requestedFiles.has(pathToFileURL(canonical(beta)).href)).toBe(true);
    expect(requestedFiles.has(pathToFileURL(canonical(gamma)).href)).toBe(true);
  });

  it("opens only changed declaration files for a demand-driven semantic query", async () => {
    const entry = cases[0]!;
    const { cwd } = project(entry);
    const alpha = join(cwd, "alpha.go");
    const beta = join(cwd, "beta.go");
    writeFileSync(alpha, "package fixture\nfunc alpha() {}\n");
    writeFileSync(beta, "package fixture\nfunc beta() {}\n");
    const sources = new Map([[canonical(alpha), "package fixture\nfunc alpha() {}\n"], [canonical(beta), "package fixture\nfunc beta() {}\n"]]);
    const parser: ParserService = {
      parse: () => Effect.die("not used"),
      parseText: () => Effect.die("not used"),
      supportedLanguages: Effect.succeed(["go"]),
      query: (file, pattern) => {
        const source = sources.get(canonical(file));
        if (!source || !pattern.includes("function_declaration")) return Effect.succeed([]);
        const name = /func (\w+)\(/.exec(source)?.[1]!;
        return Effect.succeed([{ captures: [{ name: "name", text: name, startIndex: source.indexOf(name), startLine: 2 }] }]);
      },
    };
    const opened: string[] = [];
    const report = await Effect.runPromise(collectGoSymbolUse({
      cwd,
      languages: ["go"],
      demand: { declarations: [{ file: "beta.go", names: ["beta"] }] },
    }, {
      parser,
      executable: "gopls",
      startSession: () => ({
        notify: (method, params) => {
          if (method === "textDocument/didOpen") opened.push((params as { textDocument: { uri: string } }).textDocument.uri);
        },
        close: () => undefined,
        request: async (method) => method === "initialize" ? { capabilities: { referencesProvider: true } } as never : [] as never,
      }),
    }));

    expect(opened).toEqual([pathToFileURL(canonical(beta)).href]);
    expect(semanticEvidenceView(report)).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      scope: { mode: "demand", governedFileCount: 3, selectedDeclarationFileCount: 1, declarationFamilies: ["callable"] },
      facts: [{ declaration: { name: "beta" } }],
      reason: expect.stringContaining("demand-driven semantic query selected 1/3"),
    });
  });

  it("warms static consumer candidates when the demand carries consumerFiles", async () => {
    const entry = cases[0]!;
    const { cwd } = project(entry);
    const alpha = join(cwd, "alpha.go");
    const beta = join(cwd, "beta.go");
    const gamma = join(cwd, "gamma.go");
    writeFileSync(alpha, "package fixture\nfunc alpha() {}\n");
    writeFileSync(beta, "package fixture\nfunc beta() {}\n");
    writeFileSync(gamma, "package fixture\nimport \"fixture\"\nfunc gamma() { beta() }\n");
    const sources = new Map([[canonical(alpha), "package fixture\nfunc alpha() {}\n"], [canonical(beta), "package fixture\nfunc beta() {}\n"], [canonical(gamma), "package fixture\nfunc gamma() { beta() }\n"]]);
    const parser: ParserService = {
      parse: () => Effect.die("not used"),
      parseText: () => Effect.die("not used"),
      supportedLanguages: Effect.succeed(["go"]),
      query: (file, pattern) => {
        const source = sources.get(canonical(file));
        if (!source || !pattern.includes("function_declaration")) return Effect.succeed([]);
        const name = /func (\w+)\(/.exec(source)?.[1]!;
        return Effect.succeed([{ captures: [{ name: "name", text: name, startIndex: source.indexOf(name), startLine: 2 }] }]);
      },
    };
    const opened: string[] = [];
    const report = await Effect.runPromise(collectGoSymbolUse({
      cwd,
      languages: ["go"],
      demand: {
        declarations: [{ file: "beta.go", names: ["beta"] }],
        consumerFiles: [canonical(gamma)],
      },
    }, {
      parser,
      executable: "gopls",
      startSession: () => ({
        notify: (method, params) => {
          if (method === "textDocument/didOpen") opened.push((params as { textDocument: { uri: string } }).textDocument.uri);
        },
        close: () => undefined,
        request: async (method) => method === "initialize" ? { capabilities: { referencesProvider: true } } as never : [] as never,
      }),
    }));

    // 变更文件 + 静态消费者候选都被 didOpen（消费者由绝对路径换算为仓库相对路径）
    expect(opened).toEqual([pathToFileURL(canonical(beta)).href, pathToFileURL(canonical(gamma)).href]);
    expect(semanticEvidenceView(report).scope).toMatchObject({ mode: "demand" });
  });

  it("polls workspace/symbol as the index-ready signal before references (rust indexReady)", async () => {
    const entry = cases.find((caseEntry) => caseEntry.language === "rust")!;
    const { cwd, file } = project(entry);
    const symbolQueries: string[] = [];
    const report = await Effect.runPromise(entry.collect({ cwd, languages: [entry.language] }, {
      parser: parserFor(file, entry),
      executable: "rust-server",
      startSession: () => ({
        notify: () => undefined,
        close: () => undefined,
        request: async (method, params) => {
          if (method === "workspace/symbol") {
            symbolQueries.push((params as { query: string }).query);
            // 第二次轮询回显 query 名 + 声明文件 location → 精确命中（索引就绪）
            return symbolQueries.length >= 2
              ? [{ name: (params as { query: string }).query, location: { uri: pathToFileURL(canonical(file)).href } }] as never
              : [] as never;
          }
          return method === "textDocument/references" ? [] as never
            : method === "initialize" ? { capabilities: { referencesProvider: true } } as never
            : {} as never;
        },
      }),
    }));

    // workspace/symbol 轮询确实发生（至少两次），references 未被跳过
    expect(symbolQueries.length).toBeGreaterThanOrEqual(2);
    expect(report).toBeDefined();
  }, 20_000);

  it("rewrites a .bat jdtls entry to python + stable -data (cmd /c quoting workaround)", async () => {
    const entry = cases.find((caseEntry) => caseEntry.language === "java")!;
    const { cwd, file } = project(entry);
    const launches: LspLaunchSpec[] = [];
    await Effect.runPromise(entry.collect({ cwd, languages: [entry.language] }, {
      parser: parserFor(file, entry),
      executable: "C:/tools/jdtls/bin/jdtls.bat",
      startSession: (launch) => { launches.push(launch); return session(); },
    }));

    expect(launches[0]!.command).toBe("python");
    expect(launches[0]!.args[0]).toBe("C:/tools/jdtls/bin/jdtls");
    expect(launches[0]!.args.slice(1)).toEqual(["-data", expect.any(String)]);
  });

  it("launches a node-backed .js pyright entry with --stdio (npm shim workaround)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openarch-python-js-launch-"));
    roots.push(cwd);
    const file = join(cwd, "fixture.py");
    writeFileSync(file, "def hidden(): pass\ndef exposed(): pass\n");
    const launches: LspLaunchSpec[] = [];
    await Effect.runPromise(collectPythonSymbolUse({ cwd, languages: ["python"] }, {
      parser: parserFor(file, {
        language: "python",
        extension: ".py",
        source: "def hidden(): pass\ndef exposed(): pass\n",
        internal: "hidden",
        publicName: "exposed",
        collect: collectPythonSymbolUse,
        expectedArgs: [],
        indicator: "pyproject.toml",
        query: queryPython,
        declarationQuery: "(function_definition name: (identifier) @name)",
      } as never),
      executable: "C:/tools/pyright/langserver.index.js",
      startSession: (launch) => { launches.push(launch); return session(); },
    }));

    expect(launches).toEqual([{ command: "node", args: ["C:/tools/pyright/langserver.index.js", "--stdio"] }]);
  });
});
