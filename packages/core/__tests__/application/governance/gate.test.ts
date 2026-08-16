import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CelAdapterLive } from "../../../src/adapter/rule/CelAdapter";
import { gatePerFile, classifyPath, evaluateRules, type CompiledRule, type PathEntry } from "../../../src/application/governance/gate";
import { unsupportedMetricRules } from "../../../src/application/governance/gateConfig";
import { filterMetricsForScope, gateApp, gateDiagnosticFromError } from "../../../src/application/governance/gateApp";
import { createAnalysisScope } from "../../../src/domain/analysisScope";
import { GateConfigurationError } from "../../../src/application/governance/gateConfig";
import { BaselineSchemaError, IoError, ParseError } from "../../../src/errors/errors";
import { RuleCompileError } from "../../../src/port/RuleService";
import { METRIC_CONTRACT_VERSION } from "../../../src/domain/metricCatalog";
import { makeJsonFileStorageLive } from "../../../src/adapter/storage/JsonFileStorage";
import { createStructuralCalibrationProfile, nextStructuralCalibrationState } from "../../../src/domain/calibration";
import { DEFAULT_CRL_STATE_WEIGHTS } from "../../../src/domain/crlState";

describe("classifyPath", () => {
  const paths: PathEntry[] = [
    { name: "parser", pattern: "**/adapter/rule/**" },
    { name: "domain", pattern: "**/domain/**" },
    { name: "application", pattern: "**/application/**" },
    { name: "default", pattern: "**" },
  ];

  it("POSIX 路径匹配", () => {
    expect(classifyPath("/repo/packages/core/src/domain/alpha.ts", paths)).toBe("domain");
    expect(classifyPath("/repo/packages/core/src/adapter/rule/CelAdapter.ts", paths)).toBe("parser");
  });

  it("Windows 绝对路径（反斜杠）匹配——path 权威化后路径含 \\，不能 fallback 到 default", () => {
    expect(classifyPath("E:\\workspace\\openarch\\packages\\core\\src\\domain\\alpha.ts", paths)).toBe("domain");
    expect(classifyPath("E:\\workspace\\openarch\\packages\\core\\src\\adapter\\rule\\CelAdapter.ts", paths)).toBe("parser");
    expect(classifyPath("E:\\workspace\\openarch\\packages\\core\\src\\application\\gate.ts", paths)).toBe("application");
  });

  it("未匹配任何 pattern → default", () => {
    expect(classifyPath("E:\\repo\\bin\\openarch.js", paths)).toBe("default");
  });

  it("按声明顺序匹配，第一个命中返回（parser 先于 application）", () => {
    // adapter/rule 同时不含 application，但若 pattern 重叠，顺序决定优先级
    const overlap: PathEntry[] = [
      { name: "specific", pattern: "**/rule/**" },
      { name: "general", pattern: "**/core/**" },
    ];
    expect(classifyPath("/repo/core/rule/x.ts", overlap)).toBe("specific");
  });
});

describe("evaluateRules", () => {
  const rules: CompiledRule[] = [
    { name: "high branch", level: "warn", condition: "branch_count > 8", evaluate: (v) => (v.branch_count as number) > 8 },
    { name: "block branch", level: "block", condition: "branch_count > 25", evaluate: (v) => (v.branch_count as number) > 25 },
  ];

  it("无触发 → PASS", () => {
    const r = evaluateRules(rules, { branch_count: 3 });
    expect(r.triggered).toHaveLength(0);
    expect(r.blocked).toBe(false);
    expect(r.warned).toBe(false);
  });

  it("WARN 触发，附 file", () => {
    const r = evaluateRules(rules, { branch_count: 12 }, "/abs/a.ts");
    expect(r.warned).toBe(true);
    expect(r.blocked).toBe(false);
    expect(r.triggered[0].file).toBe("/abs/a.ts");
  });

  it("BLOCK 触发", () => {
    const r = evaluateRules(rules, { branch_count: 30 });
    expect(r.blocked).toBe(true);
  });
});

describe("gatePerFile CRL_state signals", () => {
  const metrics = [{
    path: "packages/core/src/domain/example.ts", branchCount: 5, nestingDepth: 5,
    maxFuncBranch: 5, loc: 5, alphaStruct: 1, externalPassthroughCalls: 5, connectedness: 0,
  }];
  const p95 = { branch: 10, nesting: 10, loc: 10, alpha: 1, oneMinusConnectedness: 1, externalPassthrough: 10 };
  const paths = [{ name: "domain", pattern: "**/domain/**" }];

  it("does not automatically warn on the legacy composite value", async () => {
    const r = await Effect.runPromise(
      gatePerFile([], metrics, paths, { p95 }).pipe(Effect.provide(CelAdapterLive))
    );
    expect(r.verdict).toBe("PASS");
  });

  it("exposes local burden and exposure to CEL rules", async () => {
    const r = await Effect.runPromise(
      gatePerFile([
        { name: "local burden", level: "warn", condition: "crl_local > 0.3" },
        { name: "core burden", level: "warn", condition: "crl_local > 0.3 && exposure > 0.6" },
      ], metrics, paths, { p95 }).pipe(Effect.provide(CelAdapterLive))
    );
    expect(r.verdict).toBe("WARN");
    expect(r.triggered.map(t => t.name)).toEqual(["local burden", "core burden"]);
  });

  it("keeps max-function and top-level branch rules independent", async () => {
    const r = await Effect.runPromise(
      gatePerFile(
        [
          { name: "function complexity", level: "warn", condition: "max_func_branch > 5" },
          { name: "top-level dispatch", level: "warn", condition: "top_level_branch > 8" },
        ],
        [{ path: "bin/openarch.js", branchCount: 40, weightedBranchTotal: 40, topLevelWeightedBranch: 40, maxFuncBranch: 0, nestingDepth: 1 }],
        paths,
      ).pipe(Effect.provide(CelAdapterLive)),
    );
    expect(r.triggered.map((trigger) => trigger.name)).toEqual(["top-level dispatch"]);
  });

  it("does not reinterpret a legacy file aggregate as max-function complexity", async () => {
    const r = await Effect.runPromise(
      gatePerFile(
        [{ name: "function complexity", level: "warn", condition: "max_func_branch > 8" }],
        [{ path: "bin/openarch.js", branchCount: 40, nestingDepth: 1 }],
        paths,
      ).pipe(Effect.provide(CelAdapterLive)),
    );
    expect(r.verdict).toBe("PASS");
  });

  it("keeps test files out of production gate rules", async () => {
    const r = await Effect.runPromise(
      gatePerFile(
        [{ name: "production branch", level: "block", condition: "branch_count > 1" }],
        [{ path: "packages/core/__tests__/domain/example.test.ts", branchCount: 99, nestingDepth: 1, fileKind: "test" }],
        paths,
      ).pipe(Effect.provide(CelAdapterLive)),
    );
    expect(r.verdict).toBe("PASS");
  });
});

describe("gate metric boundaries", () => {
  it("rejects retired, report-only, unregistered, and change-magnitude fields as gate conditions", () => {
    const unsupported = unsupportedMetricRules([
      { name: "legacy aggregate", level: "warn", condition: "branch_count > 8" },
      { name: "file total", level: "warn", condition: "weighted_branch_total > 8" },
      { name: "top level", level: "warn", condition: "top_level_branch > 8" },
      { name: "function", level: "warn", condition: "max_func_branch > 8" },
      // 变更量是路由证据，不是可裁决门禁（校准 2026-08-15，§7.2.1）
      { name: "single push", level: "warn", condition: "i_push > 10" },
      { name: "unregistered", level: "warn", condition: "cyclomatic_complexity > 10" },
      { name: "retired composite", level: "warn", condition: "crl_state > 0.5" },
      // classifier 只允许与 gate 指标组合使用
      { name: "classifier-only", level: "warn", condition: 'path_class == "domain" && crl_local > 0.5' },
    ]);
    expect(unsupported.map((rule) => rule.name)).toEqual([
      "legacy aggregate", "file total", "top level", "single push", "unregistered", "retired composite",
    ]);
  });

  it("does not let an out-of-scope language baseline entry enter gate", () => {
    const metrics = filterMetricsForScope([
      { path: "packages/cli/bin/openarch.js" },
      { path: "packages/core/src/domain/branchMetrics.ts" },
    ], createAnalysisScope(["typescript"]));
    expect(metrics.map((metric) => metric.path)).toEqual(["packages/core/src/domain/branchMetrics.ts"]);
  });
});

describe("gate failure diagnostics", () => {
  it("maps known config, baseline, IO, parser, and rule failures without exposing raw causes", () => {
    expect(gateDiagnosticFromError(new GateConfigurationError(".openarch/config.yml", "invalid yaml")))
      .toEqual({ category: "configuration", operation: "load_config", path: ".openarch/config.yml", message: "invalid yaml" });
    expect(gateDiagnosticFromError(new BaselineSchemaError({ path: "baseline/_index.json", reason: "missing p95" })))
      .toEqual({ category: "baseline", operation: "read_baseline", path: "baseline/_index.json", message: "missing p95" });
    expect(gateDiagnosticFromError(new IoError({ path: "baseline/_index.json", cause: new Error("EACCES") })))
      .toEqual({ category: "io", operation: "read_or_write", path: "baseline/_index.json", message: "EACCES" });
    expect(gateDiagnosticFromError(new ParseError({ path: "src/a.ts", cause: "syntax error" })))
      .toEqual({ category: "parser", operation: "parse", path: "src/a.ts", message: "syntax error" });
    expect(gateDiagnosticFromError(new RuleCompileError("x @ 1", "Unexpected character: '@'")))
      .toEqual({ category: "rule", operation: "compile_rule", message: "Unexpected character: '@'" });
  });

  it("does not stringify arbitrary thrown objects into CLI diagnostics", () => {
    expect(gateDiagnosticFromError({ secret: "do-not-render" }))
      .toEqual({ category: "unexpected", operation: "evaluate_gate", message: "unavailable" });
  });

  it("preserves a real rule compilation failure through gateApp catchAll", async () => {
    const root = join(tmpdir(), `openarch-gate-diagnostic-${Date.now()}`);
    const previousBase = process.env.OPENARCH_BASE_DIR;
    const scope = createAnalysisScope(["typescript"]);
    try {
      mkdirSync(join(root, "baseline"), { recursive: true });
      writeFileSync(join(root, "config.yml"), [
        'languages: ["typescript"]',
        "rules_warn:",
        '  - name: invalid-rule',
        '    condition: "max_func_branch @ 1"',
      ].join("\n"));
      writeFileSync(join(root, "baseline", "_index.json"), JSON.stringify({
        version: "5.2",
        meta: {
          scanAt: new Date().toISOString(), nFiles: 1, nProductionFiles: 1, languages: ["typescript"],
          analysisScope: { fingerprint: scope.fingerprint, complete: true }, metricContractVersion: METRIC_CONTRACT_VERSION,
          snapshotSha256: "a".repeat(64),
          p95: { branch: 1, nesting: 1, loc: 1, alpha: 1, oneMinusConnectedness: 1, externalPassthrough: 1 },
        },
      }));
      writeFileSync(join(root, "baseline", "entry.json"), JSON.stringify({
        path: "src/a.ts", language: "typescript", fileKind: "production", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0,
        maxFuncBranch: 1, loc: 1, externalPassthroughCalls: 0, connectedness: 1,
      }));
      process.env.OPENARCH_BASE_DIR = root;
      const output = await Effect.runPromise(gateApp().pipe(Effect.provide(Layer.merge(CelAdapterLive, makeJsonFileStorageLive(root)))));
      expect(output).toMatchObject({ code: 3, verdict: "UNAVAILABLE", diagnostic: { category: "rule", operation: "compile_rule" } });
      expect(output.unavailableReason).toBe("execution_failed");
    } finally {
      if (previousBase === undefined) delete process.env.OPENARCH_BASE_DIR;
      else process.env.OPENARCH_BASE_DIR = previousBase;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps separately scoped populations of one language independent", async () => {
    const root = join(tmpdir(), `openarch-gate-policy-${Date.now()}`);
    const previousBase = process.env.OPENARCH_BASE_DIR;
    const scope = createAnalysisScope(["python"]);
    const profile = nextStructuralCalibrationState({ observed: createStructuralCalibrationProfile({
      analysisScopeFingerprint: `${scope.fingerprint}:policy:python`, metricContractVersion: METRIC_CONTRACT_VERSION,
      p95: { branch: 1, nesting: 1, loc: 1, alpha: 0, oneMinusConnectedness: 0, externalPassthrough: 0 },
      population: [{ path: "src/a.ts", maxFuncBranch: 1, nestingDepth: 1, loc: 1, alphaStruct: 0, connectedness: 1, externalPassthroughCalls: 0 }],
      weights: DEFAULT_CRL_STATE_WEIGHTS,
    }) }).state;
    try {
      mkdirSync(join(root, "baseline"), { recursive: true });
      writeFileSync(join(root, "config.yml"), [
        'languages: ["python"]',
        "structural_policies:",
        "  - id: alpha-python", "    languages: [\"python\"]", "    scope:", "      include: [\"services/alpha/**\"]", "    mode: enforce", "    rules_warn:", "      - name: alpha-branch", "        condition: \"max_func_branch > 1\"",
        "  - id: beta-python", "    languages: [\"python\"]", "    scope:", "      include: [\"services/beta/**\"]", "    mode: observe", "    rules_block: []", "    rules_warn: []",
      ].join("\n"));
      writeFileSync(join(root, "baseline", "_index.json"), JSON.stringify({ version: "5.2", meta: {
        scanAt: new Date().toISOString(), nFiles: 2, nProductionFiles: 2, languages: ["python"],
        analysisScope: { fingerprint: scope.fingerprint, complete: true }, metricContractVersion: METRIC_CONTRACT_VERSION,
        snapshotSha256: "b".repeat(64),
        policyCalibrations: { "alpha-python": profile },
      }}));
      for (const entry of [
        { path: "services/alpha/app.py", language: "python", maxFuncBranch: 1 },
        { path: "services/beta/app.py", language: "python", maxFuncBranch: 99 },
      ]) writeFileSync(join(root, "baseline", `${entry.path.replaceAll("/", "-")}.json`), JSON.stringify({
        ...entry, fileKind: "production", branchCount: entry.maxFuncBranch, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0,
        loc: 1, externalPassthroughCalls: 0, connectedness: 1,
      }));
      process.env.OPENARCH_BASE_DIR = root;
      const output = await Effect.runPromise(gateApp({ report: true }).pipe(Effect.provide(Layer.merge(CelAdapterLive, makeJsonFileStorageLive(root)))));
      expect(output).toMatchObject({ verdict: "PASS", configuredRules: 1 });
      expect(output.report?.policies).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "alpha-python", mode: "enforce", evaluatedFiles: 1 }),
        expect.objectContaining({ id: "beta-python", mode: "observe", evaluatedFiles: 1 }),
      ]));
    } finally {
      if (previousBase === undefined) delete process.env.OPENARCH_BASE_DIR;
      else process.env.OPENARCH_BASE_DIR = previousBase;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
