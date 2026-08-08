import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ParserService } from "../../src/port/ParserService";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { vitestProvider } from "../../src/test-governance/providers/vitest";

const dir = join(tmpdir(), `openarch-vitest-provider-${Date.now()}`);
const file = join(dir, "sample.test.ts");
const subject = join(dir, "subject.ts");

const collect = () => Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* Effect.promise(() => vitestProvider.collect(file, parser));
}).pipe(Effect.provide(TreeSitterParserLive));

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(subject, "export const subject = () => true;\n");
  writeFileSync(file, `
    import { describe, it, expect, vi } from "vitest";
    import { subject } from "./subject";
    it.only("focused", () => { const mock = vi.fn(); expect(mock).toBeDefined(); });
    it.skip("skipped", () => { expect(true).toBe(true); });
    it("missing", () => { const value = 1; void value; });
    describe.only("focused suite", () => { it("inside", () => { expect(true).toBe(true); }); });
    it("counts only its own control flow", async () => {
      if (true) { expect(true).toBe(true); }
      switch ("value") { case "value": break; default: break; }
      [1].forEach(() => { if (true) { expect(true).toBe(true); } });
    });
    it("calls imported subject", () => { expect(subject()).toBe(true); });
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("vitestProvider", () => {
  it("extracts test-body metrics and framework facts through AST queries", async () => {
    const result = await Effect.runPromise(collect());
    expect(result.tests.map((test) => test.name)).toEqual(["focused", "skipped", "missing", "inside", "counts only its own control flow", "calls imported subject"]);
    expect(result.tests.find((test) => test.name === "focused")?.assertionCount).toBe(1);
    expect(result.tests.find((test) => test.name === "focused")?.mockCount).toBe(1);
    expect(result.findings.map((finding) => finding.kind)).toEqual(expect.arrayContaining(["focused_test", "unapproved_skip", "missing_assertion"]));
    expect(result.findings.some((finding) => finding.evidence.includes("describe.only"))).toBe(true);
    expect(result.tests.find((test) => test.name === "counts only its own control flow")?.testBodyControlFlow).toBeCloseTo(2.6, 5);
    expect(result.symbolCallEvidence).toContainEqual({ testName: "calls imported subject", source: "./subject", symbol: "subject" });
    expect(result.testCaseSpans).toContainEqual(expect.objectContaining({ name: "focused", statuses: ["only"] }));
  }, 15000);
});
