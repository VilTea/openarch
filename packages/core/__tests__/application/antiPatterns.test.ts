import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { ParserService } from "../../src/port/ParserService";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(() => false),
}));

vi.mock("../../src/infra/glob", () => ({ globSync: vi.fn(() => { throw new Error("glob must not run for a missing rules directory"); }) }));

vi.mock("../../src/application/scriptFacts", async () => {
  const { Effect } = await import("effect");
  return { loadScriptFacts: () => Effect.succeed({}) };
});

import { antiPatterns } from "../../src/application/antiPatterns";

describe("antiPatterns", () => {
  it("treats a missing project rules directory as an empty rule set", async () => {
    const parser = {
      parse: vi.fn(), parseText: vi.fn(), query: vi.fn(), supportedLanguages: Effect.succeed([]),
    };
    const result = await Effect.runPromise(antiPatterns().pipe(Effect.provide(Layer.succeed(ParserService, parser))));
    expect(result).toMatchObject({ rulesRun: 0, hits: [], errors: [] });
  });
});
