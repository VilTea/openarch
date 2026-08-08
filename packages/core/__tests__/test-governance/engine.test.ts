import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeTestFindingScript } from "../../src/test-governance/engine";
import { normalizeRepositoryPath } from "../../src/script-runtime/projectFacts";
import { ParserService } from "../../src/port/ParserService";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";

const parser: ParserService = {
  parse: () => Effect.die("not used"),
  query: () => Effect.succeed([]),
  supportedLanguages: Effect.succeed(["typescript"]),
};

const realParser = () => Effect.runPromise(Effect.gen(function* () {
  return yield* ParserService;
}).pipe(Effect.provide(TreeSitterParserLive)));

describe("executeTestFindingScript", () => {
  it("detects direct project baseline cleanup but allows isolated temporary cleanup", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openarch-test-rule-"));
    const violation = join(cwd, "violation.test.ts");
    const legal = join(cwd, "legal.test.ts");
    const rule = resolve(process.cwd(), "../../.openarch/test-governance/rules/no-project-baseline-cleanup.mjs");
    writeFileSync(violation, 'import { rmSync } from "node:fs"; rmSync(".openarch/baseline", { recursive: true });\n');
    writeFileSync(legal, 'import { rmSync } from "node:fs"; const isolated = ".tmp"; rmSync(isolated, { recursive: true });\n');
    try {
      const service = await realParser();
      const hit = await executeTestFindingScript(rule, [violation], service);
      const clean = await executeTestFindingScript(rule, [legal], service);
      expect(hit.findings).toEqual([expect.objectContaining({ kind: "project_baseline_cleanup", confidence: "confirmed", file: normalizeRepositoryPath(violation) })]);
      expect(clean.findings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("validates findings and injects the script source", async () => {
    const result = await executeTestFindingScript("rules/focused-test.mjs", ["a.test.ts"], parser, {
      importFn: async () => ({
        default: {
          stages: {},
          link: () => [{
            ruleId: "focused-test", kind: "focused_test", file: "a.test.ts",
            evidence: ["it.only"], confidence: "confirmed",
          }],
        },
      }),
    });
    expect(result.error).toBeUndefined();
    expect(result.stages).toMatchObject({ inputFiles: 1, candidateFiles: ["a.test.ts"], records: [{ _file: "a.test.ts" }] });
    expect(result.findings).toEqual([expect.objectContaining({ source: "focused-test.mjs", kind: "focused_test" })]);
  });

  it("rejects malformed output instead of letting scripts create opaque gate data", async () => {
    const result = await executeTestFindingScript("rules/bad.mjs", [], parser, {
      importFn: async () => ({ default: { stages: {}, link: () => [{ ruleId: "bad" }] } }),
    });
    expect(result.findings).toHaveLength(0);
    expect(result.error).toContain("file");
  });

  it("times out a script instead of leaving an unbounded gate operation", async () => {
    const result = await executeTestFindingScript("rules/slow.mjs", [], parser, {
      timeoutMs: 1,
      importFn: async () => ({ default: { stages: {}, link: () => new Promise(() => undefined) } }),
    });
    expect(result.findings).toHaveLength(0);
    expect(result.error).toContain("超时");
  });

  it("rejects the retired named detect export", async () => {
    const result = await executeTestFindingScript("rules/legacy.mjs", [], parser, {
      importFn: async () => ({ detect: () => [] }),
    });
    expect(result.findings).toHaveLength(0);
    expect(result.error).toContain("必须 export default");
  });

  it("reports unavailable facts instead of silently treating a metric-dependent test rule as clean", async () => {
    const result = await executeTestFindingScript("rules/metrics.mjs", ["a.test.ts"], parser, {
      importFn: async () => ({
        default: {
          requires: ["structure-metrics.v1"], stages: {},
          link: () => { throw new Error("must not execute"); },
        },
      }),
    });
    expect(result.findings).toEqual([]);
    expect(result.unavailable).toContain("structure-metrics.v1");
  });

  it("does not run a test-scope rule without complete provider-confirmed spans", async () => {
    const result = await executeTestFindingScript("rules/test-spans.mjs", ["a.test.ts"], parser, {
      importFn: async () => ({
        default: {
          requires: ["test-case-spans.v1"], stages: {},
          link: () => { throw new Error("must not execute"); },
        },
      }),
    });
    expect(result.findings).toEqual([]);
    expect(result.unavailable).toContain("test-case-spans.v1");
  });
});
