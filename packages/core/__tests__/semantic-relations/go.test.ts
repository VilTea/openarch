import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ParserService } from "../../src/port/ParserService";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { collectGoSemanticRelations } from "../../src/adapter/semantic-relations/GoSemanticRelationProvider";
import type { LspSession } from "../../src/adapter/lsp/NodeLspSession";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

const goProject = (cwd: string): { model: string; consumer: string } => {
  mkdirSync(join(cwd, ".openarch"), { recursive: true });
  writeFileSync(join(cwd, ".openarch", "config.yml"), "version: \"5.2\"\nlanguages: [\"go\"]\n", "utf8");
  writeFileSync(join(cwd, "go.mod"), "module example.test/semantic\n\ngo 1.22\n", "utf8");
  const model = join(cwd, "model.go");
  const consumer = join(cwd, "consumer.go");
  writeFileSync(model, [
    "package semantic",
    "",
    "type Service struct {",
    "\tID string",
    "}",
    "",
    "type Other struct {",
    "\tName string",
    "}",
    "",
    "type Handler interface {",
    "\tService",
    "}",
  ].join("\n"), "utf8");
  writeFileSync(consumer, [
    "package semantic",
    "",
    "type Consumer struct {",
    "\tService",
    "\t*Other",
    "\tField Service",
    "\tPtr *Service",
    "}",
    "",
    "func (c *Consumer) Handle(item Service) Service {",
    "\treturn Service{}",
    "}",
    "",
    "func (c *Consumer) Build(item *Service) *Service {",
    "\treturn &Service{}",
    "}",
  ].join("\n"), "utf8");
  return { model, consumer };
};

const fakeGoSession = (model: string): LspSession => {
  const documents = new Map<string, string>();
  const modelUri = pathToFileURL(model).href;
  const modelLines = readFileSync(model, "utf8").split(/\r?\n/);
  const modelLineForType = (name: string): number | undefined => {
    const index = modelLines.findIndex((line) => line.includes(`type ${name} `));
    return index >= 0 ? index : undefined;
  };
  return {
    notify: (method, params) => {
      if (method === "textDocument/didOpen") {
        const { textDocument } = params as { textDocument: { uri: string; text: string } };
        documents.set(textDocument.uri, textDocument.text);
      }
    },
    request: async (method, params) => {
      if (method === "initialize") return { capabilities: { definitionProvider: true } };
      if (method === "textDocument/documentSymbol") return [];
      if (method === "textDocument/definition") {
        const { textDocument, position } = params as {
          textDocument: { uri: string };
          position: { line: number; character: number };
        };
        const source = documents.get(textDocument.uri) ?? readFileSync(fileURLToPath(textDocument.uri), "utf8");
        const lines = source.split(/\r?\n/);
        const line = lines[position.line] ?? "";
        const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(position.character))?.[0];
        if (identifier === "Service" || identifier === "Other") {
          const targetLine = modelLineForType(identifier);
          return targetLine === undefined ? null : { uri: modelUri, range: { start: { line: targetLine, character: 6 } } };
        }
        return null;
      }
      return null;
    },
    waitForDiagnostics: async () => true,
    close: () => undefined,
  };
};

const parser = async () => Effect.runPromise(Effect.gen(function* () {
  return yield* ParserService;
}).pipe(Effect.provide(TreeSitterParserLive)));

describe("go-gopls-semantic-relations", () => {
  it("resolves direct Go relations through gopls definitions", async () => {
    await withTemporaryDirectory("go-semantic-relations", async (cwd) => {
      const { model, consumer } = goProject(cwd);
      const session = fakeGoSession(model);
      const started: unknown[] = [];
      const startSession = async (launch: unknown, root: string) => {
        started.push({ launch, root });
        return session;
      };
      const result = await Effect.runPromise(collectGoSemanticRelations(
        { cwd, languages: ["go"] },
        { parser: await parser(), executable: "gopls", startSession },
      ));

      expect(started).toHaveLength(1);
      expect(result.state.availability).toBe("available");
      expect(result.state.coverage).toEqual({ symbols: "complete", relations: "complete" });
      const kinds = new Set(result.facts.map((fact) => fact.kind));
      expect(kinds).toEqual(new Set(["embeds", "field_type", "parameter_type", "return_type", "instantiates"]));
      expect(result.facts.every((fact) => fact.language === "go" && fact.direct === true)).toBe(true);
      expect(result.facts.some((fact) => fact.source.file === "consumer.go" && fact.source.name === "Consumer")).toBe(true);
      expect(result.facts.some((fact) => fact.source.file === "model.go" && fact.source.name === "Handler")).toBe(true);
      expect(result.facts.filter((fact) => fact.source.name === "Consumer").every((fact) =>
        (fact.target.name === "Service" || fact.target.name === "Other") && fact.target.scope === "repository")).toBe(true);
      expect(result.facts.every((fact) => fact.source.id.startsWith("go:repository:"))).toBe(true);
      expect(consumer).toContain("consumer.go");
    });
  });

  it("keeps the report partial when warmup or candidate resolution is incomplete", async () => {
    const previous = process.env.OPENARCH_GOPLS_DAEMON;
    process.env.OPENARCH_GOPLS_DAEMON = "off";
    try {
      await withTemporaryDirectory("go-semantic-relations-partial", async (cwd) => {
      goProject(cwd);
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
      const result = await Effect.runPromise(collectGoSemanticRelations(
        { cwd, languages: ["go"] },
        { parser: await parser(), executable: "gopls", startSession: async () => session },
      ));

      expect(result.state.availability).toBe("partial");
      expect(result.state.reason).toContain("warmup");
      });
    } finally {
      if (previous === undefined) delete process.env.OPENARCH_GOPLS_DAEMON;
      else process.env.OPENARCH_GOPLS_DAEMON = previous;
    }
  });

  it("returns unavailable when the gopls session cannot start", async () => {
    await withTemporaryDirectory("go-semantic-relations-unavailable", async (cwd) => {
      goProject(cwd);
      const result = await Effect.runPromise(collectGoSemanticRelations(
        { cwd, languages: ["go"] },
        { parser: await parser(), executable: "gopls", startSession: async () => { throw new Error("ENOENT"); } },
      ));

      expect(result.state.availability).toBe("unavailable");
      expect(result.state.reason).toContain("failed to start gopls");
    });
  });

  it.skipIf(!process.env.OPENARCH_GO_SEMANTIC_CWD)("calibrates against a real gopls workspace", { timeout: 180_000 }, async () => {
    const cwd = process.env.OPENARCH_GO_SEMANTIC_CWD!;
    const executable = process.env.OPENARCH_GO_PATH ?? "E:\\workspace\\llm\\.tools\\bin\\gopls.exe";
    const goBin = resolve(dirname(executable), "..", "go", "bin");
    const startedAt = Date.now();
    const result = await Effect.runPromise(collectGoSemanticRelations(
      { cwd, languages: ["go"] },
      {
        parser: await parser(),
        executable,
        environment: {
          ...process.env,
          PATH: [goBin, process.env.PATH].filter(Boolean).join(delimiter),
        },
      },
    ));

    const countsByKind = new Map<string, number>();
    for (const fact of result.facts) {
      countsByKind.set(fact.kind, (countsByKind.get(fact.kind) ?? 0) + 1);
    }
    console.log("[go-semantic-relations calibration]", JSON.stringify({
      cwd,
      executable,
      elapsedMs: Date.now() - startedAt,
      state: result.state,
      factCount: result.facts.length,
      countsByKind: Object.fromEntries([...countsByKind.entries()].sort()),
    }));

    expect(result.origin.providerId).toBe("go-gopls-semantic-relations");
    expect(["available", "partial"]).toContain(result.state.availability);
    expect(result.state.coverage.symbols).not.toBe("unavailable");
  });
});
