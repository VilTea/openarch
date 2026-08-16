import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { resolve } from "node:path";
import { ParserService } from "../../src/port/ParserService";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { STRING_KEY_CALLS_QUERY, stringKeyCallRecords, supportsStringKeyCalls } from "../../src/staged-analysis/stringKeyCalls";
import { executeStagedAnalysis } from "../../src/staged-analysis/engine";

const fixture = (name: string) => resolve(__dirname, "..", "..", "fixtures", name);

describe("string-key-calls-ts-js.v1", () => {
  it("extracts, normalizes and cleans declarative string-key syntax on real JavaScript", async () => {
    const parser = await Effect.runPromise(Effect.gen(function* () {
      return yield* ParserService;
    }).pipe(Effect.provide(TreeSitterParserLive)));

    const file = fixture("cordis-string-keys.mjs");
    const matches = await Effect.runPromise(parser.query(file, STRING_KEY_CALLS_QUERY).pipe(Effect.either));
    expect(matches._tag).toBe("Right");
    if (matches._tag !== "Right") return;
    const records = stringKeyCallRecords(matches.right);

    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "array", name: "inject", key: "tools" }),
      expect.objectContaining({ kind: "array", name: "inject", key: "timer" }),
      expect.objectContaining({ kind: "local", name: "url", value: "/api/openarch/governance-state" }),
      expect.objectContaining({ kind: "local", name: "url", value: "/api/openarch/governance-state?force=1" }),
      expect.objectContaining({ kind: "call", op: "ctx.get", key: "webServer" }),
      expect.objectContaining({ kind: "call", op: "web.register", pkey: "path", key: "/api/openarch/governance-state" }),
      expect.objectContaining({ kind: "dynamicCall", op: "ctx.get", arg: "dynamicKey" }),
      expect.objectContaining({ kind: "call", op: "harness.handle", key: "openarch/governance-state" }),
      expect.objectContaining({ kind: "call", op: "host.call", key: "openarch/governance-state" }),
      expect.objectContaining({ kind: "callArg", op: "fetch", arg: "url" }),
    ]));
  });

  it("is exposed as an engine-owned AST fact with normalized _file records", async () => {
    const parser = await Effect.runPromise(Effect.gen(function* () {
      return yield* ParserService;
    }).pipe(Effect.provide(TreeSitterParserLive)));

    const file = fixture("cordis-string-keys.mjs");
    const result = await executeStagedAnalysis({ ast: { fact: "string-key-calls-ts-js.v1" } }, [file], parser);

    expect(result.unavailable).toBeUndefined();
    expect(result.stages?.records.every((record) => /(?:^|\/)fixtures\/cordis-string-keys\.mjs$/.test(record._file))).toBe(true);
    expect(result.stages?.records.every((record) => !/^[A-Za-z]:/.test(record._file))).toBe(true);
    expect(result.stages?.records.some((record) => record.kind === "call" && record.op === "host.call")).toBe(true);
  });

  it("keeps accepting the pre-language-qualified id as a compatibility alias", async () => {
    const parser = await Effect.runPromise(Effect.gen(function* () {
      return yield* ParserService;
    }).pipe(Effect.provide(TreeSitterParserLive)));
    const file = fixture("cordis-string-keys.mjs");
    const result = await executeStagedAnalysis({ ast: { fact: "string-key-calls.v1" } }, [file], parser);
    expect(result.unavailable).toBeUndefined();
    expect(result.stages?.records.length).toBeGreaterThan(0);
  });

  it("fails closed for unsupported languages instead of guessing", async () => {
    expect(supportsStringKeyCalls("src/main.py")).toBe(false);
    expect(supportsStringKeyCalls("src/main.ts")).toBe(true);
    expect(supportsStringKeyCalls("src/main.mjs")).toBe(true);

    const parser = await Effect.runPromise(Effect.gen(function* () {
      return yield* ParserService;
    }).pipe(Effect.provide(TreeSitterParserLive)));
    const result = await executeStagedAnalysis({ ast: { fact: "string-key-calls-ts-js.v1" } }, ["src/main.py"], parser);
    expect(result.unavailable).toContain("only TypeScript/JavaScript");
  });
});
