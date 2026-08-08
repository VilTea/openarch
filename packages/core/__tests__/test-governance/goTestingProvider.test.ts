import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ParserService } from "../../src/port/ParserService";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { goTestingProvider } from "../../src/test-governance/providers/goTesting";

const dir = join(tmpdir(), `openarch-go-testing-provider-${Date.now()}`);
const file = join(dir, "sample_test.go");

const collect = () => Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* Effect.promise(() => goTestingProvider.collect(file, parser));
}).pipe(Effect.provide(TreeSitterParserLive));

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `
package sample

import "testing"

func TestFailure(test *testing.T) {
  if got := 1; got != 2 { test.Fatalf("got %d", got) }
}

func TestControlFlow(test *testing.T) {
  if true { test.Fatal("failure") }
  switch "value" { case "value": break; default: break }
  func() { if true { test.Fatal("nested") } }()
}

func TestSkipped(test *testing.T) {
  test.Skip("platform-specific")
}

func TestNestedSkip(test *testing.T) {
  func() { test.Skip("not owned by outer static body") }
}

func TestHelper(value string) { _ = value }
`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("goTestingProvider", () => {
  it("recognizes standard Go test signatures, assertion calls, and direct skip calls without assuming an assertion library", async () => {
    const result = await Effect.runPromise(collect());
    expect(result.tests).toEqual(expect.arrayContaining([expect.objectContaining({ name: "TestFailure", assertionCount: 1, mockCount: 0 })]));
    expect(result.tests.find((test) => test.name === "TestControlFlow")?.testBodyControlFlow).toBeCloseTo(2.6, 5);
    expect(result.findings).toEqual([expect.objectContaining({
      ruleId: "go-testing.skip-call", kind: "unapproved_skip", testName: "TestSkipped", confidence: "high",
    })]);
    expect(result.testCaseSpans).toContainEqual(expect.objectContaining({ name: "TestFailure", statuses: [] }));
  }, 15000);
});
