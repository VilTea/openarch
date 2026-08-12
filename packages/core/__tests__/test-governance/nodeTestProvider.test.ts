import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ParserService } from "../../src/port/ParserService";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { nodeTestProvider } from "../../src/test-governance/providers/nodeTest";

const dir = join(tmpdir(), `openarch-nodetest-provider-${Date.now()}`);
const file = join(dir, "sample.test.js");
const subject = join(dir, "subject.js");

const collect = () => Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* Effect.promise(() => nodeTestProvider.collect(file, parser));
}).pipe(Effect.provide(TreeSitterParserLive));

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(subject, "export const subject = () => true;\n");
  writeFileSync(file, `
    import { test, describe, it } from "node:test";
    import assert from "node:assert";
    import { subject } from "./subject.js";
    test("has assert.strictEqual", () => { assert.strictEqual(1, 1); });
    test("has assert.ok", () => { assert.ok(true); });
    test("has bare assert call", () => { assert(1 === 1, "condition"); });
    test.skip("skipped", () => { assert.equal(1, 1); });
    describe("suite", () => { it("inner with deepStrictEqual", () => { assert.deepStrictEqual({ a: 1 }, { a: 1 }); }); });
    test("missing", () => { const value = 1; void value; });
    test("calls imported subject", () => { assert.equal(subject(), true); });
    test("counts only its own control flow", () => {
      if (true) { assert.ok(true); }
      switch ("value") { case "value": break; default: break; }
    });
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("nodeTestProvider", () => {
  it("extracts test-body metrics and node:test facts through AST queries", async () => {
    const result = await Effect.runPromise(collect());
    expect(result.tests.map((test) => test.name)).toEqual([
      "has assert.strictEqual", "has assert.ok", "has bare assert call", "skipped", "inner with deepStrictEqual", "missing", "calls imported subject", "counts only its own control flow",
    ]);
    expect(result.tests.find((test) => test.name === "has assert.strictEqual")?.assertionCount).toBe(1);
    expect(result.tests.find((test) => test.name === "has assert.ok")?.assertionCount).toBe(1);
    expect(result.tests.find((test) => test.name === "has bare assert call")?.assertionCount).toBe(1);
    expect(result.tests.find((test) => test.name === "inner with deepStrictEqual")?.assertionCount).toBe(1);
    expect(result.tests.find((test) => test.name === "skipped")?.statuses).toEqual(["skip"]);
    expect(result.findings.some((finding) => finding.kind === "missing_assertion" && finding.testName === "missing")).toBe(true);
    expect(result.findings.some((finding) => finding.kind === "unapproved_skip" && finding.testName === "skipped")).toBe(true);
    expect(result.tests.find((test) => test.name === "counts only its own control flow")?.testBodyControlFlow).toBeCloseTo(2.6, 5);
    expect(result.symbolCallEvidence).toContainEqual({ testName: "calls imported subject", source: "./subject.js", symbol: "subject" });
    expect(result.testCaseSpans).toContainEqual(expect.objectContaining({ name: "skipped", statuses: ["skip"] }));
  }, 15000);
});
