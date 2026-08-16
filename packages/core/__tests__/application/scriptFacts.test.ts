import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { ParseError } from "../../src/errors/errors";
import { ParserService } from "../../src/port/ParserService";
import { SemanticRelationService } from "../../src/port/SemanticRelationService";
import type { InvocationBindingFact } from "../../src/domain/invocationBindings";
import { loadScriptFacts, type ScriptFactBaseline } from "../../src/application/scriptFacts";

const unused = (): Effect.Effect<never, ParseError> => Effect.fail(new ParseError({ path: "unused", cause: new Error("not used") }));

const parserWith = (invocationBindings: (path: string) => Effect.Effect<readonly InvocationBindingFact[], ParseError>) =>
  Layer.succeed(ParserService, {
    parse: unused,
    parseText: () => unused(),
    query: () => unused(),
    supportedLanguages: Effect.succeed([]),
    invocationBindings,
  });

const binding = (path: string): InvocationBindingFact => ({
  path, receiver: "service", method: "get", target: "Service.get", evidence: "import_alias",
});

const baseline: ScriptFactBaseline = { entries: new Map(), index: null };

describe("loadScriptFacts", () => {
  it("collects parser and provider capabilities only when scripts request them", async () => {
    let invocationCalls = 0;
    let semanticCalls = 0;
    const parser = parserWith((path) => {
      invocationCalls += 1;
      return Effect.succeed([binding(path)]);
    });
    const semantic = Layer.succeed(SemanticRelationService, {
      collect: () => {
        semanticCalls += 1;
        return Effect.succeed([]);
      },
    });

    const facts = await Effect.runPromise(loadScriptFacts({
      files: ["packages/core/src/index.ts"],
      requestedCapabilities: [],
      baseline,
    }).pipe(Effect.provide(parser), Effect.provide(semantic)));

    expect(invocationCalls).toBe(0);
    expect(semanticCalls).toBe(0);
    expect(facts.invocationBindings.availability).toBe("unavailable");
    expect(facts.invocationBindings.reason).toContain("invocation-bindings.v1");
    expect(facts.semanticRelations.availability).toBe("unavailable");
    expect(facts.semanticRelations.reason).toContain("semantic-relations.v1");
  });

  it("starts both providers when the loaded scripts declare the capabilities", async () => {
    let invocationCalls = 0;
    let semanticCalls = 0;
    const parser = parserWith((path) => {
      invocationCalls += 1;
      return Effect.succeed([binding(path)]);
    });
    const semantic = Layer.succeed(SemanticRelationService, {
      collect: () => {
        semanticCalls += 1;
        return Effect.succeed([]);
      },
    });

    const facts = await Effect.runPromise(loadScriptFacts({
      files: ["packages/core/src/index.ts"],
      requestedCapabilities: ["invocation-bindings.v1", "semantic-relations.v1"],
      baseline,
    }).pipe(Effect.provide(parser), Effect.provide(semantic)));

    expect(invocationCalls).toBe(1);
    expect(semanticCalls).toBe(1);
    expect(facts.invocationBindings.availability).toBe("available");
    expect(facts.semanticRelations.availability).toBe("available");
  });
});
