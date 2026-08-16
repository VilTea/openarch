import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ParserService } from "../../src/port/ParserService";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { collectRustSemanticRelations, rustSemanticRelationProvider } from "../../src/adapter/semantic-relations/RustSemanticRelationProvider";
import type { LspSession } from "../../src/adapter/lsp/NodeLspSession";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

const rustProject = (cwd: string): { model: string; consumer: string } => {
  mkdirSync(join(cwd, ".openarch"), { recursive: true });
  writeFileSync(join(cwd, ".openarch", "config.yml"), "version: \"5.2\"\nlanguages: [\"rust\"]\n", "utf8");
  writeFileSync(join(cwd, "Cargo.toml"), "[package]\nname = \"semantic-relations-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n", "utf8");
  const model = join(cwd, "model.rs");
  const consumer = join(cwd, "consumer.rs");
  writeFileSync(model, [
    "pub struct Request { pub id: u64 }",
    "",
    "pub struct Response { pub body: u64 }",
    "",
    "pub enum State { On, Off }",
    "",
    "pub trait Service {",
    "    fn run(&self, input: Request) -> Response;",
    "}",
  ].join("\n"), "utf8");
  writeFileSync(consumer, [
    "pub struct Handler { pub dep: Request, pub state: State }",
    "",
    "impl Service for Handler {",
    "    fn run(&self, input: Request) -> Response {",
    "        Response { body: 1 }",
    "    }",
    "}",
    "",
    "impl Handler {",
    "    fn build(&self, req: Request) -> Response {",
    "        Handler { dep: req, state: State::On }",
    "    }",
    "}",
  ].join("\n"), "utf8");
  return { model, consumer };
};

const lineOf = (file: string, needle: string): number => {
  const index = readFileSync(file, "utf8").split("\n").findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`fixture line not found: ${needle} in ${file}`);
  return index;
};

const identifierAt = (source: string, line: number, character: number): string | undefined => {
  const lineText = source.split("\n")[line] ?? "";
  const isIdentifierChar = (char: string | undefined): boolean => char !== undefined && /[A-Za-z0-9_]/.test(char);
  if (!isIdentifierChar(lineText[character])) return undefined;
  let start = character;
  while (start > 0 && isIdentifierChar(lineText[start - 1])) start -= 1;
  let end = character;
  while (end < lineText.length && isIdentifierChar(lineText[end])) end += 1;
  return lineText.slice(start, end);
};

interface FakeDefinition { readonly uri: string; readonly line: number; readonly character: number }

const fakeDefinitionSession = (definitions: Record<string, FakeDefinition>): LspSession => ({
  notify: () => undefined,
  request: async (method: string, params: unknown) => {
    if (method === "initialize") return { capabilities: { definitionProvider: true } };
    if (method === "textDocument/documentSymbol") return [];
    if (method === "workspace/symbol") {
      const { query } = params as { query?: string };
      const definition = query ? definitions[query] : undefined;
      return definition ? [{ name: query, location: { uri: definition.uri } }] : [];
    }
    if (method !== "textDocument/definition") return null;
    const { textDocument, position } = params as { textDocument?: { uri?: string }; position?: { line?: number; character?: number } };
    const uri = textDocument?.uri;
    if (!uri || position?.line === undefined || position.character === undefined) return null;
    const source = readFileSync(fileURLToPath(uri), "utf8");
    const name = identifierAt(source, position.line, position.character);
    if (!name) return null;
    const definition = definitions[name];
    return definition
      ? { uri: definition.uri, range: { start: { line: definition.line, character: definition.character } } }
      : null;
  },
  waitForDiagnostics: async () => true,
  close: () => undefined,
});

const parser = async () => Effect.runPromise(Effect.gen(function* () {
  return yield* ParserService;
}).pipe(Effect.provide(TreeSitterParserLive)));

/** rust-analyzer needs cargo on PATH for proc-macro/build-script workspace loading. */
const RUST_ANALYZER_DEFAULT_PATH = "E:\\workspace\\llm\\.tools\\rust-analyzer\\2026-07-20\\rust-analyzer.exe";
const CARGO_EXECUTABLE = "C:\\Users\\Administrator\\.cargo\\bin\\cargo.exe";
const rustAnalyzerEnvironment = (): NodeJS.ProcessEnv | undefined =>
  process.platform === "win32"
    ? { ...process.env, PATH: [dirname(CARGO_EXECUTABLE), process.env.PATH].filter(Boolean).join(delimiter) }
    : undefined;

describe("rust-rust-analyzer-semantic-relations", () => {
  it("declares the rust-analyzer LSP provider contract", () => {
    expect(rustSemanticRelationProvider).toMatchObject({
      id: "rust-rust-analyzer-semantic-relations",
      evidenceSource: "lsp",
      languages: ["rust"],
      requiredToolchains: ["rust-analyzer"],
    });
  });

  it("resolves direct Rust relations through rust-analyzer definitions", async () => {
    await withTemporaryDirectory("rust-semantic-relations", async (cwd) => {
      const { model, consumer } = rustProject(cwd);
      const session = fakeDefinitionSession({
        Request: { uri: pathToFileURL(model).href, line: lineOf(model, "pub struct Request"), character: 11 },
        Response: { uri: pathToFileURL(model).href, line: lineOf(model, "pub struct Response"), character: 11 },
        State: { uri: pathToFileURL(model).href, line: lineOf(model, "pub enum State"), character: 9 },
        Service: { uri: pathToFileURL(model).href, line: lineOf(model, "pub trait Service"), character: 10 },
        Handler: { uri: pathToFileURL(consumer).href, line: lineOf(consumer, "pub struct Handler"), character: 11 },
      });
      const started: unknown[] = [];
      const startSession = async (launch: unknown, root: string) => {
        started.push({ launch, root });
        return session;
      };
      const result = await Effect.runPromise(collectRustSemanticRelations(
        { cwd, languages: ["rust"] },
        { parser: await parser(), executable: "rust-analyzer", startSession },
      ));

      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ launch: { command: "rust-analyzer", args: [] }, root: cwd });
      expect(result.state.availability).toBe("available");
      expect(result.state.coverage).toEqual({ symbols: "complete", relations: "complete" });
      expect(new Set(result.facts.map((fact) => fact.kind))).toEqual(new Set([
        "implements", "field_type", "parameter_type", "return_type", "instantiates",
      ]));
      expect(result.facts.every((fact) => fact.language === "rust" && fact.direct === true)).toBe(true);
      expect(result.facts.every((fact) => fact.source.file === "consumer.rs" && fact.source.name === "Handler")).toBe(true);

      expect(result.facts.find((fact) => fact.kind === "implements")).toMatchObject({
        source: { name: "Handler", kind: "struct", scope: "repository" },
        target: { name: "Service", kind: "trait", scope: "repository", file: "model.rs" },
      });
      expect(result.facts.filter((fact) => fact.kind === "field_type")).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: expect.objectContaining({ name: "Handler" }), target: expect.objectContaining({ name: "Request", file: "model.rs" }) }),
        expect.objectContaining({ source: expect.objectContaining({ name: "Handler" }), target: expect.objectContaining({ name: "State", file: "model.rs" }) }),
      ]));
      expect(result.facts.filter((fact) => fact.kind === "instantiates")).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: expect.objectContaining({ name: "Response" }) }),
        expect.objectContaining({ target: expect.objectContaining({ name: "Handler" }) }),
      ]));

      for (let index = 1; index < result.facts.length; index += 1) {
        const previous = result.facts[index - 1];
        const current = result.facts[index];
        const order = previous.evidence.file.localeCompare(current.evidence.file)
          || previous.evidence.line - current.evidence.line
          || previous.kind.localeCompare(current.kind)
          || previous.source.id.localeCompare(current.source.id)
          || previous.target.id.localeCompare(current.target.id);
        expect(order).toBeLessThanOrEqual(0);
      }
    });
  });

  it("keeps the report partial when warmup or candidate resolution is incomplete", async () => {
    await withTemporaryDirectory("rust-semantic-relations-partial", async (cwd) => {
      rustProject(cwd);
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
      const result = await Effect.runPromise(collectRustSemanticRelations(
        { cwd, languages: ["rust"] },
        { parser: await parser(), executable: "rust-analyzer", startSession: async () => session },
      ));

      expect(result.state.availability).toBe("partial");
      expect(result.state.reason).toContain("warmup");
    });
  });

  it("returns unavailable when the rust-analyzer session cannot start", async () => {
    await withTemporaryDirectory("rust-semantic-relations-unavailable", async (cwd) => {
      rustProject(cwd);
      const result = await Effect.runPromise(collectRustSemanticRelations(
        { cwd, languages: ["rust"] },
        { parser: await parser(), executable: "rust-analyzer", startSession: async () => { throw new Error("ENOENT"); } },
      ));

      expect(result.state.availability).toBe("unavailable");
      expect(result.state.reason).toContain("failed to start rust-analyzer");
    });
  });

  it.skipIf(!process.env.OPENARCH_RUST_SEMANTIC_CWD)("calibrates against a real rust-analyzer workspace", { timeout: 180_000 }, async () => {
    const cwd = process.env.OPENARCH_RUST_SEMANTIC_CWD!;
    const executable = process.env.OPENARCH_RUST_PATH ?? RUST_ANALYZER_DEFAULT_PATH;
    const result = await Effect.runPromise(collectRustSemanticRelations(
      { cwd, languages: ["rust"] },
      { parser: await parser(), executable, ...(rustAnalyzerEnvironment() ? { environment: rustAnalyzerEnvironment() } : {}) },
    ));

    expect(result.origin.providerId).toBe("rust-rust-analyzer-semantic-relations");
    expect(["available", "partial"]).toContain(result.state.availability);
    expect(result.state.coverage.symbols).not.toBe("unavailable");
  });
});
