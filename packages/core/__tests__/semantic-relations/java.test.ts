import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ParserService } from "../../src/port/ParserService";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { collectJavaSemanticRelations } from "../../src/adapter/semantic-relations/JavaSemanticRelationProvider";
import type { LspSession } from "../../src/adapter/lsp/NodeLspSession";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

const javaProject = (cwd: string): { model: string; contract: string; consumer: string } => {
  mkdirSync(join(cwd, ".openarch"), { recursive: true });
  writeFileSync(join(cwd, ".openarch", "config.yml"), "version: \"5.2\"\nlanguages: [\"java\"]\n", "utf8");
  const model = join(cwd, "Service.java");
  const contract = join(cwd, "Contract.java");
  const consumer = join(cwd, "Consumer.java");
  writeFileSync(model, "public class Service {}\n", "utf8");
  writeFileSync(contract, "public interface Contract {}\n", "utf8");
  writeFileSync(consumer, [
    "public class Consumer extends Service implements Contract {",
    "  private Service field;",
    "  public Service handle(Service input) {",
    "    return new Service();",
    "  }",
    "}",
    "",
  ].join("\n"), "utf8");
  return { model, contract, consumer };
};

const scopedJavaProject = (cwd: string): { model: string; contract: string; result: string; consumer: string } => {
  mkdirSync(join(cwd, ".openarch"), { recursive: true });
  writeFileSync(join(cwd, ".openarch", "config.yml"), "version: \"5.2\"\nlanguages: [\"java\"]\n", "utf8");
  mkdirSync(join(cwd, "com", "example", "model"), { recursive: true });
  mkdirSync(join(cwd, "com", "example", "api"), { recursive: true });
  mkdirSync(join(cwd, "com", "example", "app"), { recursive: true });
  const model = join(cwd, "com", "example", "model", "Service.java");
  const contract = join(cwd, "com", "example", "api", "Contract.java");
  const result = join(cwd, "com", "example", "api", "Result.java");
  const consumer = join(cwd, "com", "example", "app", "Consumer.java");
  writeFileSync(model, "package com.example.model;\npublic class Service {}\n", "utf8");
  writeFileSync(contract, "package com.example.api;\npublic interface Contract {}\n", "utf8");
  writeFileSync(result, "package com.example.api;\npublic class Result {}\n", "utf8");
  writeFileSync(consumer, [
    "package com.example.app;",
    "public class Consumer extends com.example.model.Service implements com.example.api.Contract {",
    "  private com.example.api.Result field;",
    "  public com.example.api.Result handle(com.example.api.Result input) {",
    "    return new com.example.api.Result();",
    "  }",
    "}",
    "",
  ].join("\n"), "utf8");
  return { model, contract, result, consumer };
};

const identifierAt = (source: string, line: number, character: number): string | undefined => {
  const lineText = source.split(/\r?\n/)[line] ?? "";
  const matches = [...lineText.matchAll(/[A-Za-z_$][\w$]*/g)];
  return matches.find((match) => match.index !== undefined && character >= match.index && character < match.index + match[0].length)?.[0];
};

const fakeSession = (
  sources: ReadonlyMap<string, string>,
  targets: ReadonlyMap<string, { readonly uri: string; readonly line: number }>,
): LspSession => ({
  notify: () => undefined,
  request: async (method: string, params: unknown) => {
    if (method === "initialize") return { capabilities: { definitionProvider: true } };
    if (method !== "textDocument/definition") return null;
    const request = params as { textDocument?: { uri?: string }; position?: { line: number; character: number } };
    if (!request.textDocument?.uri || !request.position) return null;
    const source = sources.get(fileURLToPath(request.textDocument.uri));
    if (!source) return null;
    const identifier = identifierAt(source, request.position.line, request.position.character);
    const target = identifier ? targets.get(identifier) : undefined;
    return target ? { uri: target.uri, range: { start: { line: target.line, character: 0 } } } : null;
  },
  waitForDiagnostics: async () => true,
  close: () => undefined,
});

const parser = async () => Effect.runPromise(Effect.gen(function* () {
  return yield* ParserService;
}).pipe(Effect.provide(TreeSitterParserLive)));

describe("java-jdtls-semantic-relations", () => {
  it("resolves direct Java relations through JDT LS definitions", async () => {
    await withTemporaryDirectory("java-semantic-relations", async (cwd) => {
      const { model, contract, consumer } = javaProject(cwd);
      const sources = new Map<string, string>();
      for (const file of [model, contract, consumer]) sources.set(file, readFileSync(file, "utf8"));
      const session = fakeSession(sources, new Map([
        ["Service", { uri: pathToFileURL(model).href, line: 0 }],
        ["Contract", { uri: pathToFileURL(contract).href, line: 0 }],
      ]));
      const started: { launch: unknown; root: string }[] = [];
      const startSession = async (launch: unknown, root: string) => {
        started.push({ launch, root });
        return session;
      };
      const result = await Effect.runPromise(collectJavaSemanticRelations(
        { cwd, languages: ["java"] },
        { parser: await parser(), executable: "jdtls.bat", startSession },
      ));

      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ launch: { command: "jdtls.bat", args: [] }, root: cwd });
      expect(result.state.availability).toBe("available");
      expect(result.state.coverage).toEqual({ symbols: "complete", relations: "complete" });
      const kinds = new Set(result.facts.map((fact) => fact.kind));
      expect(kinds).toEqual(new Set(["extends", "implements", "field_type", "parameter_type", "return_type", "instantiates"]));
      expect(result.facts.every((fact) => fact.language === "java" && fact.direct === true)).toBe(true);
      expect(result.facts.every((fact) => fact.source.file === "Consumer.java" && fact.source.name === "Consumer" && fact.source.kind === "class")).toBe(true);
      const nonImplements = result.facts.filter((fact) => fact.kind !== "implements");
      expect(nonImplements.every((fact) => fact.target.file === "Service.java" && fact.target.name === "Service" && fact.target.kind === "class")).toBe(true);
      const implementsFacts = result.facts.filter((fact) => fact.kind === "implements");
      expect(implementsFacts.length).toBeGreaterThan(0);
      expect(implementsFacts.every((fact) => fact.target.file === "Contract.java" && fact.target.name === "Contract" && fact.target.kind === "interface")).toBe(true);
      expect(result.facts.map((fact) => fact.evidence.file)).toEqual(expect.arrayContaining(["Consumer.java"]));
      expect(consumer).toContain("Consumer.java");
    });
  });

  it("resolves scoped type references from the final identifier segment", async () => {
    await withTemporaryDirectory("java-semantic-relations-scoped", async (cwd) => {
      const { model, contract, result, consumer } = scopedJavaProject(cwd);
      const sources = new Map<string, string>();
      for (const file of [model, contract, result, consumer]) sources.set(file, readFileSync(file, "utf8"));
      const session = fakeSession(sources, new Map([
        ["Service", { uri: pathToFileURL(model).href, line: 1 }],
        ["Contract", { uri: pathToFileURL(contract).href, line: 1 }],
        ["Result", { uri: pathToFileURL(result).href, line: 1 }],
      ]));
      const resultReport = await Effect.runPromise(collectJavaSemanticRelations(
        { cwd, languages: ["java"] },
        { parser: await parser(), executable: "jdtls.bat", startSession: async () => session },
      ));

      expect(resultReport.state.availability).toBe("available");
      const kinds = new Set(resultReport.facts.map((fact) => fact.kind));
      expect(kinds).toEqual(new Set(["extends", "implements", "field_type", "parameter_type", "return_type", "instantiates"]));
      expect(resultReport.facts.every((fact) => fact.source.file === "com/example/app/Consumer.java" && fact.source.name === "Consumer")).toBe(true);
      const targetOf = (kind: string) => resultReport.facts.filter((fact) => fact.kind === kind).map((fact) => fact.target);
      expect(targetOf("extends").every((target) => target.file === "com/example/model/Service.java" && target.name === "Service" && target.kind === "class")).toBe(true);
      expect(targetOf("implements").every((target) => target.file === "com/example/api/Contract.java" && target.name === "Contract" && target.kind === "interface")).toBe(true);
      expect(targetOf("field_type").concat(targetOf("return_type"), targetOf("instantiates"))
        .every((target) => target.file === "com/example/api/Result.java" && target.name === "Result" && target.kind === "class")).toBe(true);
      expect(targetOf("parameter_type").every((target) => target.file === "com/example/api/Result.java" && target.name === "Result")).toBe(true);
    });
  });

  it("keeps the report partial when warmup is incomplete", async () => {
    await withTemporaryDirectory("java-semantic-relations-partial", async (cwd) => {
      javaProject(cwd);
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
      const result = await Effect.runPromise(collectJavaSemanticRelations(
        { cwd, languages: ["java"] },
        { parser: await parser(), executable: "jdtls", startSession: async () => session },
      ));

      expect(result.state.availability).toBe("partial");
      expect(result.state.reason).toContain("warmup");
    });
  });

  it("returns unavailable when the JDT LS session cannot start", async () => {
    await withTemporaryDirectory("java-semantic-relations-unavailable", async (cwd) => {
      javaProject(cwd);
      const result = await Effect.runPromise(collectJavaSemanticRelations(
        { cwd, languages: ["java"] },
        { parser: await parser(), executable: "jdtls", startSession: async () => { throw new Error("ENOENT"); } },
      ));

      expect(result.state.availability).toBe("unavailable");
      expect(result.state.reason).toContain("failed to start jdtls");
    });
  });

  it.skipIf(!process.env.OPENARCH_JAVA_SEMANTIC_CWD)("calibrates against a real JDT LS workspace", { timeout: 180_000 }, async () => {
    const cwd = process.env.OPENARCH_JAVA_SEMANTIC_CWD!;
    const executable = process.env.OPENARCH_JAVA_PATH ?? "E:\\workspace\\llm\\.tools\\jdtls\\1.61.0-202607231254\\bin\\jdtls.bat";
    const result = await Effect.runPromise(collectJavaSemanticRelations(
      { cwd, languages: ["java"] },
      { parser: await parser(), executable },
    ));

    expect(result.origin.providerId).toBe("java-jdtls-semantic-relations");
    expect(["available", "partial"]).toContain(result.state.availability);
    expect(result.state.coverage.symbols).not.toBe("unavailable");
  });
});
