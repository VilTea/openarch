import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ParserService } from "../../src/port/ParserService";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { collectPythonSemanticRelations } from "../../src/adapter/semantic-relations/PythonSemanticRelationProvider";
import type { LspSession } from "../../src/adapter/lsp/NodeLspSession";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

const pythonProject = (cwd: string): { model: string; consumer: string } => {
  mkdirSync(join(cwd, ".openarch"), { recursive: true });
  writeFileSync(join(cwd, ".openarch", "config.yml"), "version: \"5.2\"\nlanguages: [\"python\"]\n", "utf8");
  const model = join(cwd, "model.py");
  const consumer = join(cwd, "consumer.py");
  writeFileSync(model, "class Service:\n    pass\n", "utf8");
  writeFileSync(consumer, "class Handler(Service):\n    field: Service\n    def handle(self, item: Service) -> Service:\n        return Service()\n", "utf8");
  return { model, consumer };
};

const fakeSession = (model: string): LspSession => {
  const modelUri = pathToFileURL(model).href;
  return {
    notify: () => undefined,
    request: async (method: string, params: unknown) => {
      if (method === "initialize") return { capabilities: { definitionProvider: true } };
      if (method !== "textDocument/definition") return null;
      const { position } = params as { position?: { line: number; character: number } };
      return position
        ? { uri: modelUri, range: { start: { line: 0, character: 6 } } }
        : null;
    },
    waitForDiagnostics: async () => true,
    close: () => undefined,
  };
};

const parser = async () => Effect.runPromise(Effect.gen(function* () {
  return yield* ParserService;
}).pipe(Effect.provide(TreeSitterParserLive)));

describe("python-pyright-semantic-relations", () => {
  it("resolves direct Python relations through Pyright definitions", async () => {
    await withTemporaryDirectory("python-semantic-relations", async (cwd) => {
      const { model, consumer } = pythonProject(cwd);
      const session = fakeSession(model);
      const started: unknown[] = [];
      const startSession = async (launch: unknown, root: string) => {
        started.push({ launch, root });
        return session;
      };
      const result = await Effect.runPromise(collectPythonSemanticRelations(
        { cwd, languages: ["python"] },
        { parser: await parser(), executable: "pyright-langserver.js", startSession },
      ));

      expect(started).toHaveLength(1);
      expect(result.state.availability).toBe("available");
      expect(result.state.coverage).toEqual({ symbols: "complete", relations: "complete" });
      const kinds = new Set(result.facts.map((fact) => fact.kind));
      expect(kinds).toEqual(new Set(["extends", "field_type", "parameter_type", "return_type", "instantiates"]));
      expect(result.facts.every((fact) => fact.language === "python" && fact.direct === true)).toBe(true);
      expect(result.facts.every((fact) => fact.source.file === "consumer.py" && fact.source.name === "Handler")).toBe(true);
      expect(result.facts.every((fact) => fact.target.file === "model.py" && fact.target.name === "Service")).toBe(true);
      expect(consumer).toContain("consumer.py");
    });
  });

  it("keeps the report partial when warmup or candidate resolution is incomplete", async () => {
    await withTemporaryDirectory("python-semantic-relations-partial", async (cwd) => {
      pythonProject(cwd);
      const session: LspSession = {
        notify: () => undefined,
        request: async (method: string) => {
          if (method === "initialize") return { capabilities: { definitionProvider: true } };
          if (method === "textDocument/documentSymbol") throw new Error("warmup timeout");
          return null;
        },
        waitForDiagnostics: async () => false,
        close: () => undefined,
      };
      const result = await Effect.runPromise(collectPythonSemanticRelations(
        { cwd, languages: ["python"] },
        { parser: await parser(), executable: "pyright", startSession: async () => session },
      ));

      expect(result.state.availability).toBe("partial");
      expect(result.state.reason).toContain("warmup");
    });
  });

  it("returns unavailable when the Pyright session cannot start", async () => {
    await withTemporaryDirectory("python-semantic-relations-unavailable", async (cwd) => {
      pythonProject(cwd);
      const result = await Effect.runPromise(collectPythonSemanticRelations(
        { cwd, languages: ["python"] },
        { parser: await parser(), executable: "pyright", startSession: async () => { throw new Error("ENOENT"); } },
      ));

      expect(result.state.availability).toBe("unavailable");
      expect(result.state.reason).toContain("failed to start pyright");
    });
  });

  it.skipIf(!process.env.OPENARCH_PYRIGHT_SEMANTIC_CWD)("calibrates against a real Pyright workspace", { timeout: 180_000 }, async () => {
    const cwd = process.env.OPENARCH_PYRIGHT_SEMANTIC_CWD!;
    const executable = process.env.OPENARCH_PYRIGHT_PATH ?? "pyright-langserver";
    const result = await Effect.runPromise(collectPythonSemanticRelations(
      { cwd, languages: ["python"] },
      { parser: await parser(), executable },
    ));

    expect(result.origin.providerId).toBe("python-pyright-semantic-relations");
    expect(["available", "partial"]).toContain(result.state.availability);
    expect(result.state.coverage.symbols).not.toBe("unavailable");
  });
});
