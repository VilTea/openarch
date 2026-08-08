import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { collectPythonSymbolUse } from "../../src/adapter/symbol-use/PythonSymbolUseProvider";
import type { LspSession } from "../../src/adapter/lsp/NodeLspSession";
import type { ParserService } from "../../src/port/ParserService";
import { semanticEvidenceView } from "../support/semanticEvidence";

const roots: string[] = [];
const canonical = (path: string): string => realpathSync.native(path);

const project = (source: string): { readonly cwd: string; readonly file: string } => {
  const cwd = mkdtempSync(join(tmpdir(), "openarch-python-symbol-use-"));
  roots.push(cwd);
  writeFileSync(join(cwd, "pyproject.toml"), "[project]\nname = 'fixture'\nversion = '0.0.0'\n");
  const file = join(cwd, "module.py");
  writeFileSync(file, source);
  return { cwd, file };
};

const parserFor = (file: string, dynamicResolution = false, startIndex = 4, startLine = 1): ParserService => ({
  parse: () => Effect.die("not used"),
  parseText: () => Effect.die("not used"),
  supportedLanguages: Effect.succeed(["python"]),
  query: (path, pattern) => {
    expect(canonical(path)).toBe(canonical(file));
    if (pattern.includes("@callee")) return Effect.succeed(dynamicResolution
      ? [{ captures: [{ name: "callee", text: "getattr" }] }]
      : []);
    return Effect.succeed(pattern.includes("function_definition")
      ? [{ captures: [{ name: "name", text: "_private", startLine, startIndex }] }]
      : []);
  },
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("collectPythonSymbolUse", () => {
  it("combines parser-confirmed identifier anchors with Pyright references", async () => {
    const source = "# 中文说明\n\ndef _private():\n    return 1\n\n_private()\n";
    const { cwd, file } = project(source);
    const notifications: string[] = [];
    const session: LspSession = {
      notify: (method) => { notifications.push(method); },
      close: () => undefined,
      request: async (method, params) => {
        if (method === "initialize") {
          expect(params).toMatchObject({
            rootUri: pathToFileURL(canonical(cwd)).href,
            workspaceFolders: [{ uri: pathToFileURL(canonical(cwd)).href }],
          });
          return { capabilities: { referencesProvider: true } } as never;
        }
        if (method === "textDocument/documentSymbol") return [] as never;
        expect(params).toMatchObject({ position: { line: 2, character: 4 }, context: { includeDeclaration: false } });
        return [{ uri: pathToFileURL(canonical(file)).href, range: { start: { line: 5, character: 0 } } }] as never;
      },
    };

    const report = await Effect.runPromise(collectPythonSymbolUse({ cwd, languages: ["python"] }, {
      parser: parserFor(file, false, source.indexOf("_private"), 3), executable: "pyright-langserver", startSession: () => session,
    }));

    expect(semanticEvidenceView(report)).toMatchObject({
      availability: "available",
      coverage: { declarations: "complete", repositoryReferences: "complete" },
      facts: [{
        declaration: { file: "module.py", name: "_private", kind: "function", line: 3 },
        repositoryReferences: [{ file: "module.py", line: 6 }],
        publicSurface: "internal",
      }],
    });
    expect(notifications).toEqual(["initialized", "textDocument/didOpen", "exit"]);
  });

  it("accepts an LSP reference-provider options object", async () => {
    const { cwd, file } = project("def _private():\n    return 1\n");
    const session: LspSession = {
      notify: () => undefined,
      close: () => undefined,
      request: async (method, params) => {
        if (method === "initialize") {
          expect(params).toMatchObject({ capabilities: { textDocument: { references: { dynamicRegistration: false } } } });
          return { capabilities: { referencesProvider: { workDoneProgress: true } } } as never;
        }
        return [] as never;
      },
    };

    const report = await Effect.runPromise(collectPythonSymbolUse({ cwd, languages: ["python"] }, {
      parser: parserFor(file), executable: "pyright-langserver", startSession: () => session,
    }));

    expect(semanticEvidenceView(report)).toMatchObject({
      availability: "available",
      coverage: { declarations: "complete", repositoryReferences: "complete" },
      facts: [{ declaration: { name: "_private" }, repositoryReferences: [] }],
    });
  });

  it("keeps failed reference resolution partial instead of inventing zero uses", async () => {
    const { cwd, file } = project("def _private():\n    return 1\n");
    const session: LspSession = {
      notify: () => undefined,
      close: () => undefined,
      request: async (method) => {
        if (method === "initialize") return { capabilities: { referencesProvider: true } } as never;
        if (method === "textDocument/documentSymbol") return [] as never;
        throw new Error("Pyright index unavailable");
      },
    };

    const report = await Effect.runPromise(collectPythonSymbolUse({ cwd, languages: ["python"] }, {
      parser: parserFor(file), executable: "pyright-langserver", startSession: () => session,
    }));

    expect(semanticEvidenceView(report)).toMatchObject({
      availability: "partial",
      coverage: { declarations: "complete", repositoryReferences: "partial" },
      facts: [],
    });
  });

  it("excludes Python special methods while retaining name-mangled internal declarations", async () => {
    const { cwd, file } = project("class Sample:\n    def __init__(self):\n        pass\n\n    def __private(self):\n        return 1\n");
    const parser: ParserService = {
      parse: () => Effect.die("not used"),
      parseText: () => Effect.die("not used"),
      supportedLanguages: Effect.succeed(["python"]),
      query: (_path, pattern) => Effect.succeed(pattern.includes("function_definition")
        ? [
          { captures: [{ name: "name", text: "__init__", startLine: 2, startIndex: 22 }] },
          { captures: [{ name: "name", text: "__private", startLine: 5, startIndex: 60 }] },
        ]
        : []),
    };
    const session: LspSession = {
      notify: () => undefined,
      close: () => undefined,
      request: async (method) => method === "initialize"
        ? { capabilities: { referencesProvider: true } } as never
        : [] as never,
    };

    const report = await Effect.runPromise(collectPythonSymbolUse({ cwd, languages: ["python"] }, {
      parser, executable: "pyright-langserver", startSession: () => session,
    }));

    expect(report.facts.map((fact) => fact.declaration.name)).toEqual(["__private"]);
  });

  it("prepares reference-only modules before resolving an imported private alias", async () => {
    const { cwd, file: producer } = project("def _aliased():\n    return 1\n");
    const consumer = join(cwd, "consumer.py");
    writeFileSync(consumer, "from module import _aliased as alias\nalias()\n");
    const parser: ParserService = {
      parse: () => Effect.die("not used"),
      parseText: () => Effect.die("not used"),
      supportedLanguages: Effect.succeed(["python"]),
      query: (path, pattern) => {
        if (pattern.includes("@callee")) return Effect.succeed([]);
        return Effect.succeed(canonical(path) === canonical(producer) && pattern.includes("function_definition")
          ? [{ captures: [{ name: "name", text: "_aliased", startLine: 1, startIndex: 4 }] }]
          : []);
      },
    };
    const symbolRequests: string[] = [];
    const session: LspSession = {
      notify: () => undefined,
      close: () => undefined,
      request: async (method, params) => {
        if (method === "initialize") return { capabilities: { referencesProvider: true } } as never;
        if (method === "textDocument/documentSymbol") {
          symbolRequests.push((params as { textDocument: { uri: string } }).textDocument.uri);
          return [] as never;
        }
        return [{ uri: pathToFileURL(canonical(consumer)).href, range: { start: { line: 0, character: 19 } } }] as never;
      },
    };

    const report = await Effect.runPromise(collectPythonSymbolUse({ cwd, languages: ["python"] }, {
      parser, executable: "pyright-langserver", startSession: () => session,
    }));

    expect(semanticEvidenceView(report)).toMatchObject({
      availability: "available",
      facts: [{ declaration: { name: "_aliased" }, repositoryReferences: [{ file: "consumer.py", line: 1 }] }],
    });
    expect(symbolRequests).toEqual(expect.arrayContaining([pathToFileURL(canonical(producer)).href, pathToFileURL(canonical(consumer)).href]));
  });

  it("treats parser-confirmed dynamic resolution as incomplete even when Pyright returns no references", async () => {
    const { cwd, file } = project("def _private():\n    return 1\n\ngetattr(module, '_private')\n");
    const session: LspSession = {
      notify: () => undefined,
      close: () => undefined,
      request: async (method) => method === "initialize"
        ? { capabilities: { referencesProvider: true } } as never
        : [] as never,
    };

    const report = await Effect.runPromise(collectPythonSymbolUse({ cwd, languages: ["python"] }, {
      parser: parserFor(file, true), executable: "pyright-langserver", startSession: () => session,
    }));

    expect(semanticEvidenceView(report)).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      reason: expect.stringContaining("dynamic Python import or attribute resolution"),
    });
    expect(report.facts[0]?.repositoryReferences).toEqual([]);
  });

  it("keeps abstract-method dispatch partial when direct references are empty", async () => {
    const { cwd, file } = project("from abc import abstractmethod\n\nclass _Base:\n    @abstractmethod\n    def _run(self): ...\n");
    const parser: ParserService = {
      parse: () => Effect.die("not used"),
      parseText: () => Effect.die("not used"),
      supportedLanguages: Effect.succeed(["python"]),
      query: (_path, pattern) => Effect.succeed(pattern.includes("@decorator")
        ? [{ captures: [{ name: "decorator", text: "abstractmethod" }] }]
        : pattern.includes("function_definition")
          ? [{ captures: [{ name: "name", text: "_run", startLine: 5, startIndex: 75 }] }]
          : []),
    };
    const session: LspSession = {
      notify: () => undefined,
      close: () => undefined,
      request: async (method) => method === "initialize"
        ? { capabilities: { referencesProvider: true } } as never
        : [] as never,
    };

    const report = await Effect.runPromise(collectPythonSymbolUse({ cwd, languages: ["python"] }, {
      parser, executable: "pyright-langserver", startSession: () => session,
    }));

    expect(semanticEvidenceView(report)).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      reason: expect.stringContaining("abstract-method dispatch"),
    });
    expect(report.facts[0]?.repositoryReferences).toEqual([]);
  });

  it("keeps runtime import-path mutation partial even when Pyright returns direct references", async () => {
    const { cwd, file } = project("import sys\n\ndef _private():\n    return 1\n\nsys.meta_path.append(finder)\n");
    const parser: ParserService = {
      parse: () => Effect.die("not used"),
      parseText: () => Effect.die("not used"),
      supportedLanguages: Effect.succeed(["python"]),
      query: (_path, pattern) => Effect.succeed(pattern.includes("augmented_assignment")
        ? [{ captures: [{ name: "receiver", text: "sys" }, { name: "property", text: "meta_path" }] }]
        : pattern.includes("function_definition")
          ? [{ captures: [{ name: "name", text: "_private", startLine: 3, startIndex: 16 }] }]
          : []),
    };
    const session: LspSession = {
      notify: () => undefined,
      close: () => undefined,
      request: async (method) => method === "initialize"
        ? { capabilities: { referencesProvider: true } } as never
        : [] as never,
    };

    const report = await Effect.runPromise(collectPythonSymbolUse({ cwd, languages: ["python"] }, {
      parser, executable: "pyright-langserver", startSession: () => session,
    }));

    expect(semanticEvidenceView(report)).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      reason: expect.stringContaining("runtime import-path mutation"),
    });
  });

  it("keeps explicit Pyright execution environments partial", async () => {
    const { cwd, file } = project("def _private():\n    return 1\n");
    writeFileSync(join(cwd, "pyrightconfig.json"), JSON.stringify({ executionEnvironments: [{ root: "." }] }));
    const session: LspSession = {
      notify: () => undefined,
      close: () => undefined,
      request: async (method) => method === "initialize"
        ? { capabilities: { referencesProvider: true } } as never
        : [] as never,
    };

    const report = await Effect.runPromise(collectPythonSymbolUse({ cwd, languages: ["python"] }, {
      parser: parserFor(file), executable: "pyright-langserver", startSession: () => session,
    }));

    expect(semanticEvidenceView(report)).toMatchObject({
      availability: "partial",
      coverage: { declarations: "complete", repositoryReferences: "partial" },
      reason: expect.stringContaining("execution-environment"),
    });
  });

  it("keeps pyproject tool.pyright resolution configuration partial", async () => {
    const { cwd, file } = project("def _private():\n    return 1\n");
    writeFileSync(join(cwd, "pyproject.toml"), "[tool.pyright]\nextraPaths = [\"src\"]\n");
    const session: LspSession = {
      notify: () => undefined,
      close: () => undefined,
      request: async (method) => method === "initialize"
        ? { capabilities: { referencesProvider: true } } as never
        : [] as never,
    };

    const report = await Effect.runPromise(collectPythonSymbolUse({ cwd, languages: ["python"] }, {
      parser: parserFor(file), executable: "pyright-langserver", startSession: () => session,
    }));

    expect(semanticEvidenceView(report)).toMatchObject({
      availability: "partial",
      coverage: { declarations: "complete", repositoryReferences: "partial" },
      reason: expect.stringContaining("execution-environment"),
    });
  });

  it("honors pyrightconfig.json precedence over pyproject tool.pyright settings", async () => {
    const { cwd, file } = project("def _private():\n    return 1\n");
    writeFileSync(join(cwd, "pyproject.toml"), "[tool.pyright]\nextraPaths = [\"src\"]\n");
    writeFileSync(join(cwd, "pyrightconfig.json"), "{}");
    const session: LspSession = {
      notify: () => undefined,
      close: () => undefined,
      request: async (method) => method === "initialize"
        ? { capabilities: { referencesProvider: true } } as never
        : [] as never,
    };

    const report = await Effect.runPromise(collectPythonSymbolUse({ cwd, languages: ["python"] }, {
      parser: parserFor(file), executable: "pyright-langserver", startSession: () => session,
    }));

    expect(semanticEvidenceView(report)).toMatchObject({
      availability: "available",
      coverage: { declarations: "complete", repositoryReferences: "complete" },
    });
  });
});
