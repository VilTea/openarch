import { describe, expect, it } from "vitest";
import { renderTestCoverage, renderTestGovernanceReport, testGovernanceJsonValue } from "../../src/report/testReport";
import type { TestGovernanceReport } from "@openarch/core";

describe("renderTestCoverage", () => {
  it("keeps unavailable coverage distinct from the policy verdict", () => {
    const lines = renderTestCoverage({
      status: "unavailable",
      reasons: ["test_files_unrecognized"],
      testFiles: 2,
      unbaselinedTestFiles: [],
      providerHandledTestFiles: [],
      unrecognizedTestFiles: ["tests/verify.ts", "tests/tui-harness.ts"],
      failedTestFiles: [],
    });

    expect(lines).toContain("- 覆盖状态: UNAVAILABLE");
    expect(lines).toContain("- 覆盖限制: test_files_unrecognized");
    expect(lines.join("\n")).not.toContain("PASS");
  });

  /**
   * D-G8：两个数字来自不同总体，必须标来源并解释差异。
   *
   * D-G18（2026-09-25 项目所有者批准）：provider 采集范围改为实时发现集合后，
   * 「provider 只采集 baseline 中已存在的测试文件」已**不成立**，该文案必须改——
   * 否则报告在差异归因上说假话。差异原因改为"未被当前启用 provider 处理"。
   */
  it("labels which population each count comes from and explains a difference", () => {
    const lines = renderTestCoverage({
      status: "available",
      reasons: [],
      testFiles: 252,
      unbaselinedTestFiles: [],
      providerHandledTestFiles: ["a.ts", "b.ts"],
      unrecognizedTestFiles: [],
      failedTestFiles: [],
    });
    expect(lines).toContain("- 覆盖范围: 可发现测试文件（实时分类）=252, provider 成功处理（实时发现，按 provider.supports 过滤）=2");
    expect(lines).toContainEqual(expect.stringContaining("总体差异: 252 个实时分类中 2 个被当前启用 provider 成功处理"));
    // D-G18：不得再声称 provider 只采集 baseline 条目。
    expect(lines.join("\n")).not.toContain("provider 只采集 baseline 中已存在的测试文件");
    // 两个总体一致时不加噪声
    const same = renderTestCoverage({
      status: "available", reasons: [], testFiles: 2, unbaselinedTestFiles: [],
      providerHandledTestFiles: ["a.ts", "b.ts"], unrecognizedTestFiles: [], failedTestFiles: [],
    });
    expect(same.some((line) => line.includes("总体差异"))).toBe(false);
  });
});

describe("testGovernanceJsonValue", () => {
  it("projects the stable v1 machine contract with provider boundaries and suggestions", () => {
    const report = {
      decision: {
        verdict: "WARN",
        findings: [
          { ruleId: "x", kind: "missing_assertion", file: "tests/a.test.ts", testName: "a", evidence: [], confidence: "low", source: "typescript-vitest" },
          unbaselinedMissingAssertion("tests/new.test.ts", "fresh"),
        ],
        triggered: [{ level: "warn", finding: { kind: "missing_assertion", file: "tests/a.test.ts", testName: "a", confidence: "low" } }],
        exempted: [{ kind: "missing_assertion", file: "tests/b.test.ts", testName: "b", confidence: "low" }],
        errors: ["runner failed"],
      },
      collection: {
        coverage: { status: "partial", reasons: ["test_files_missing_from_baseline"], testFiles: 2, unbaselinedTestFiles: ["tests/new.test.ts"], providerHandledTestFiles: ["tests/a.test.ts"], unrecognizedTestFiles: [], failedTestFiles: [] },
        providerCoverage: [{ providerId: "typescript-vitest", status: "partial", reasons: ["test_files_missing_from_baseline"], candidateTestFiles: ["tests/a.test.ts", "tests/new.test.ts"], unbaselinedTestFiles: ["tests/new.test.ts"], providerHandledTestFiles: ["tests/a.test.ts"], failedTestFiles: [] }],
        testFiles: 2,
        providersRun: ["typescript-vitest"],
        providerSummaries: [{ providerId: "typescript-vitest", testFiles: 1, testCases: 2, p95: { loc: 10, assertionCount: 2, mockCount: 0, testBodyControlFlow: 1 } }],
        testCaseSpans: { availability: "partial", value: [], reason: "some files unhandled" },
        unrecognizedTestFiles: [],
        suggestedAdapters: { providers: ["typescript-vitest"], runners: ["node-test"] },
        staticModuleAssociations: [{ testFile: "tests/a.test.ts", association: { targetPath: "src/a.ts", confidence: "medium", testName: "a", symbol: "a" } }, { testFile: "tests/a.test.ts", association: { targetPath: "src/b.ts", confidence: "low", testName: "a", symbol: "b" } }],
        associationUnavailableTestFiles: ["tests/c.test.ts"],
      },
      execution: { runnersRun: ["node-test"], executions: [{ providerId: "node-test", execution: { passed: true, command: "node --test" } }] },
      scripts: { scriptUnavailable: ["rules/x.mjs: missing"], scriptPruning: [{ rule: "rules/x.mjs", inputFiles: 2, targetFiles: 1, candidateFiles: 1, records: 0 }] },
    } as unknown as TestGovernanceReport;

    const json = testGovernanceJsonValue(report);
    expect(json.schema).toBe("test-governance-json-v1");
    expect(json.verdict).toBe("WARN");
    expect(json.decision.errors).toEqual(["runner failed"]);
    expect(json.decision.triggered[0]).toEqual({ level: "warn", kind: "missing_assertion", file: "tests/a.test.ts", testName: "a" });
    // 缺陷 1：逐条 finding 投影；provider 未给 line 时不伪造该键。
    // D-G18：未入 baseline 的 finding 带来源标记（非破坏追加，不改变其余字段）。
    expect(json.decision.findings).toEqual([
      { file: "tests/a.test.ts", case: "a", kind: "missing_assertion", evidence: [], confidence: "low" },
      { file: "tests/new.test.ts", case: "fresh", kind: "missing_assertion", evidence: ["no recognised JUnit assertion in test body"], confidence: "low", unbaselined: true },
    ]);
    expect(json.collection.coverage.unbaselinedTestFiles).toBe(1);
    expect(json.collection.providers[0]).toMatchObject({ providerId: "typescript-vitest", status: "partial", candidates: 2, handled: 1, missingBaseline: 1, failed: 0 });
    expect(json.collection.suggestedAdapters).toEqual({ providers: ["typescript-vitest"], runners: ["node-test"] });
    expect(json.collection.staticModuleAssociations).toEqual({ testFiles: 1, modules: 2, edges: 2, low: 1, medium: 1 });
    expect(json.execution.executions[0]).toEqual({ providerId: "node-test", passed: true, command: "node --test" });
  });
});

/** TEST_BLOAT 观察面夹具（缺陷修复 2）：可用因子（有值+贡献）与不可测因子
 *  （UNAVAILABLE + reason，绝无 value/contribution）并存，并带块级证据。 */
const bloatFixture = (options: { readonly triggered?: boolean; readonly unavailable?: boolean } = {}) => ({
  score: options.unavailable ? 0.8 : 0.1,
  triggered: options.triggered ?? false,
  availableWeight: options.unavailable ? 0.5 : 1,
  codeSimilarityRatio: 1.25,
  parts: [
    { name: "codeSimilarityRatio", value: 1.25, threshold: 0.06, weight: 0.3, contribution: 0.3, availability: "AVAILABLE", suggestion: "抽取公共 fixture 工厂" },
    ...(options.unavailable
      ? [{ name: "fixtureBoilerplateRatio", threshold: 0.08, weight: 0.3, contribution: 0, availability: "UNAVAILABLE", reason: "language_not_supported_by_pattern", suggestion: "提取共享测试工具" }]
      : [{ name: "fixtureBoilerplateRatio", value: 0.02, threshold: 0.08, weight: 0.3, contribution: 0.075, availability: "AVAILABLE", suggestion: "提取共享测试工具" }]),
  ],
  evidence: [
    { factor: "codeSimilarityRatio", file: "src/test/java/com/example/OrderServiceTest.java", value: 45, detail: "与其它文件共享相似块 45 行", startLine: 25, endLine: 32, sample: "@BeforeEach\nvoid setUp() {" },
  ],
  similarityBuckets: {
    assemblyRatio: options.unavailable ? 0.04 : 0.02,
    unclassifiedRatio: 0.11,
    assertionRatio: 0.09,
    caseBodyRatio: options.unavailable ? 0.03 : 0.05,
    filesWithoutBlockEvidence: options.unavailable ? 2 : 0,
    filesWithoutCaseSpans: options.unavailable ? 1 : 0,
    caseSpansAvailability: options.unavailable ? "partial" : "available",
  },
});

/** 缺陷 1 的测试夹具：只造 decision/collection 的事实面，其余节留空。 */
const reportWithDecision = (
  decision: {
    readonly verdict: "PASS" | "WARN" | "BLOCK";
    readonly findings: readonly Record<string, unknown>[];
    readonly triggered?: readonly { readonly level: "block" | "warn"; readonly finding: Record<string, unknown> }[];
    readonly exempted?: readonly Record<string, unknown>[];
    readonly errors?: readonly string[];
  },
  options: { readonly bloat?: boolean } = {},
): TestGovernanceReport => ({
  decision: {
    verdict: decision.verdict,
    findings: decision.findings,
    triggered: decision.triggered ?? [],
    exempted: decision.exempted ?? [],
    errors: decision.errors ?? [],
  },
  collection: {
    coverage: { status: "available", reasons: [], testFiles: 1, unbaselinedTestFiles: [], providerHandledTestFiles: ["tests/a.test.ts"], unrecognizedTestFiles: [], failedTestFiles: [] },
    providerCoverage: [], testFiles: 1, providersRun: ["typescript-vitest"], providerSummaries: [],
    testCaseSpans: { availability: "available", value: [] }, staticModuleAssociations: [], associationUnavailableTestFiles: [], unrecognizedTestFiles: [],
  },
  execution: { runnersRun: [], executions: [] },
  scripts: { scriptUnavailable: [], scriptPruning: [] },
  ...(options.bloat ? { bloat: bloatFixture() } : {}),
} as unknown as TestGovernanceReport);

const missingAssertion = (file: string, testName: string, line?: number): Record<string, unknown> => ({
  ruleId: "java-junit.missing-known-assertion", kind: "missing_assertion", file, testName: testName,
  evidence: ["no recognised JUnit assertion in test body"], confidence: "low", source: "java-junit",
  ...(line === undefined ? {} : { line }),
});

/** D-G18：未入 baseline 的测试文件产出的 finding 带来源标记。 */
const unbaselinedMissingAssertion = (file: string, testName: string, line?: number): Record<string, unknown> => ({
  ...missingAssertion(file, testName, line), unbaselined: true,
});

/** CLI 退出码只由 decision.verdict 决定（packages/cli/src/commands/test.ts:31）。 */
const exitCodeOf = (verdict: "PASS" | "WARN" | "BLOCK"): number => (verdict === "BLOCK" ? 2 : verdict === "WARN" ? 1 : 0);

const deepFreeze = <T,>(value: T): T => {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
};

describe("testGovernanceJsonValue findings（缺陷 1：逐条可定位）", () => {
  it("projects every finding with file, case, kind and provider line, without omitting review-only ones", () => {
    const report = reportWithDecision({
      verdict: "PASS",
      findings: [missingAssertion("tests/a.test.ts", "first", 12), missingAssertion("tests/b.test.ts", "second", 34)],
    });
    const json = testGovernanceJsonValue(report);
    expect(json.decision.findings).toHaveLength(2);
    expect(json.decision.findings[0]).toEqual({
      file: "tests/a.test.ts", case: "first", kind: "missing_assertion", line: 12,
      evidence: ["no recognised JUnit assertion in test body"], confidence: "low",
    });
    expect(json.decision.findings[1]).toMatchObject({ file: "tests/b.test.ts", case: "second", kind: "missing_assertion", line: 34 });
    // D-G18 非破坏性：已入 baseline 的 finding 不带 `unbaselined` 键（缺省即旧语义）。
    expect(json.decision.findings.every((finding) => !("unbaselined" in finding))).toBe(true);
  });

  /**
   * D-G18（2026-09-25 项目所有者批准）：`decision.findings[]` 逐条投影新增来源标记
   * `unbaselined`。provider 采集范围改为实时发现集合后，finding 可能没有 baseline 对账对象，
   * 消费方必须能分辨——但这是**非破坏追加**（不设该键时输出逐字节不变），
   * 所以 `test-governance-json-v1` 不 bump。
   */
  it("marks findings from unbaselined test files without changing findings that are baselined", () => {
    const report = reportWithDecision({
      verdict: "PASS",
      findings: [missingAssertion("tests/a.test.ts", "baselined", 12), unbaselinedMissingAssertion("tests/new.test.ts", "fresh", 3)],
    });
    const json = testGovernanceJsonValue(report);
    expect(json.decision.findings[0]).toEqual({
      file: "tests/a.test.ts", case: "baselined", kind: "missing_assertion", line: 12,
      evidence: ["no recognised JUnit assertion in test body"], confidence: "low",
    });
    expect(json.decision.findings[1]).toEqual({
      file: "tests/new.test.ts", case: "fresh", kind: "missing_assertion", line: 3,
      evidence: ["no recognised JUnit assertion in test body"], confidence: "low", unbaselined: true,
    });
    // 观察面：来源标记不改变裁决与退出码。
    expect(json.decision.findingCount).toBe(2);
    expect(json.verdict).toBe("PASS");
    expect(exitCodeOf(json.verdict)).toBe(0);
  });

  it("includes triggered and exempted findings too (only review-only was dropped before)", () => {
    const triggeredFinding = missingAssertion("tests/a.test.ts", "first", 12);
    const report = reportWithDecision({
      verdict: "WARN",
      findings: [triggeredFinding, missingAssertion("tests/b.test.ts", "second", 34), { ...missingAssertion("tests/c.test.ts", "third"), ruleId: "java-junit.disabled-test", kind: "unapproved_skip" }],
      triggered: [{ level: "warn", finding: triggeredFinding }],
      exempted: [{ ...missingAssertion("tests/c.test.ts", "third"), ruleId: "java-junit.disabled-test", kind: "unapproved_skip" }],
    });
    const json = testGovernanceJsonValue(report);
    expect(json.decision.findings.map((finding) => finding.case)).toEqual(["first", "second", "third"]);
    expect(json.decision.triggered).toHaveLength(1);
    expect(json.decision.exemptedCount).toBe(1);
  });

  it("keeps the top-level contract surface at the 7-field report-surface-audit budget", () => {
    const report = reportWithDecision({ verdict: "PASS", findings: [missingAssertion("tests/a.test.ts", "first", 12)] }, { bloat: true });
    const json = testGovernanceJsonValue(report);
    // 所有可选节都在场时的顶层字段全集：schema/verdict/decision/collection/execution/scripts/bloat。
    expect(Object.keys(json).sort()).toEqual(["bloat", "collection", "decision", "execution", "schema", "scripts", "verdict"]);
    expect(Object.keys(json).length).toBeLessThanOrEqual(7);
    // 逐条 finding 在 decision 内（唯一裁决面），不新增顶层字段。
    expect(Object.keys(json)).not.toContain("findings");
  });

  it("stays observe-only: no input mutation, and verdict / gate / exit code are untouched", () => {
    const triggeredFinding = missingAssertion("tests/a.test.ts", "first", 12);
    const report = deepFreeze(reportWithDecision({
      verdict: "WARN",
      findings: [triggeredFinding, missingAssertion("tests/b.test.ts", "second", 34)],
      triggered: [{ level: "warn", finding: triggeredFinding }],
    }));
    const decisionBefore = structuredClone(report.decision);
    const exitBefore = exitCodeOf(report.decision.verdict);
    // 冻结对象在严格模式下被写会抛错 ⇒ 不抛即证明投影只读。
    const json = testGovernanceJsonValue(report);
    expect(structuredClone(report.decision)).toEqual(decisionBefore);
    expect(json.verdict).toBe("WARN");
    expect(json.decision.verdict).toBe(report.decision.verdict);
    expect(json.decision.findings).toHaveLength(2);
    expect(json.decision.triggered).toHaveLength(1);
    expect(exitCodeOf(json.verdict)).toBe(exitBefore);
  });

  it("leaves a review-only report's verdict at PASS and exit code at 0 even with findings present", () => {
    const report = reportWithDecision({
      verdict: "PASS",
      findings: [missingAssertion("tests/a.test.ts", "first", 12), missingAssertion("tests/b.test.ts", "second", 34)],
    });
    const json = testGovernanceJsonValue(report);
    // 观察面：finding 进入 JSON，但不进 triggered ⇒ 不影响 gate 与退出码。
    expect(json.decision.findings).toHaveLength(2);
    expect(json.decision.triggered).toEqual([]);
    expect(json.verdict).toBe("PASS");
    expect(exitCodeOf(json.verdict)).toBe(0);
  });
});

describe("renderTestGovernanceReport", () => {
  it("exposes the test-illusion family and route without changing policy", () => {
    const report = {
      decision: {
        findings: [{ ruleId: "pytest.missing", kind: "missing_assertion", file: "tests/test_a.py", testName: "test_a", evidence: ["no assert"], confidence: "low", source: "python-pytest" }],
        triggered: [], exempted: [], errors: [],
      },
      collection: {
        coverage: { status: "available", reasons: [], testFiles: 1, unbaselinedTestFiles: [], providerHandledTestFiles: ["tests/test_a.py"], unrecognizedTestFiles: [], failedTestFiles: [] },
        providerCoverage: [], testFiles: 1, providersRun: ["python-pytest"], providerSummaries: [],
        testCaseSpans: { availability: "available", value: [] }, staticModuleAssociations: [], associationUnavailableTestFiles: [], unrecognizedTestFiles: [],
      },
      execution: { runnersRun: [], executions: [] }, scripts: { scriptUnavailable: [], scriptPruning: [] },
    } as unknown as TestGovernanceReport;
    const lines = renderTestGovernanceReport(report, ["--verbose"]);
    expect(lines).toContainEqual(expect.stringContaining("test-illusion"));
    expect(lines).toContainEqual(expect.stringContaining("missing_assertion"));
  });

  /** D-G6 后续：新 kind 必须有调查建议，否则信号出现却没有下一步。 */
  it("gives empty_test_body findings their own investigation route", () => {
    const report = reportWithDecision({
      verdict: "PASS",
      findings: [{ ruleId: "java-junit.empty-test-body", kind: "empty_test_body", file: "src/test/java/demo/FixtureTest.java", testName: "example", line: 12, evidence: ["recognised JUnit @Test method with an empty body (no statement)"], confidence: "low" }],
    });
    const lines = renderTestGovernanceReport(report, []);
    expect(lines).toContainEqual(expect.stringContaining("empty_test_body=1"));
    expect(lines).toContainEqual(expect.stringContaining("调查建议 (empty-case-body)"));
    expect(lines).toContainEqual(expect.stringContaining("被测夹具"));
  });

  it("renders the provider line in verbose findings (defect 1 text surface)", () => {
    const report = reportWithDecision({ verdict: "PASS", findings: [missingAssertion("tests/a.test.ts", "first", 12)] });
    expect(renderTestGovernanceReport(report, [])).not.toContainEqual(expect.stringContaining("L12"));
    expect(renderTestGovernanceReport(report, ["--verbose"])).toContainEqual(expect.stringContaining("tests/a.test.ts L12 (first)"));
  });

  /**
   * G2（2026-09-25 实地核实）：verdict 可以来自 `decision.errors`（例如 config.yml 写了未知
   * provider id ⇒ `errors.length > 0 ? "BLOCK"`），此时"仅基于已收集的 finding"是假话。
   * 真实观测：报告同时打印 `适配器建议: providers=[junit]` 与
   * `策略裁决: BLOCK（仅基于已收集的 finding）`，而真相是 `未知测试 provider: junit`。
   */
  it("renders the verdict basis honestly when BLOCK comes from errors, not findings", () => {
    const fromErrors = renderTestGovernanceReport(
      reportWithDecision({ verdict: "BLOCK", findings: [], errors: ["未知测试 provider: junit"] }),
      [],
    );
    expect(fromErrors).toContainEqual(expect.stringContaining("BLOCK 来自 1 项治理错误"));
    expect(fromErrors).toContainEqual(expect.stringContaining("[CONFIG ERROR] 未知测试 provider: junit"));
    // 无错误时保持原文，不引入噪声
    const fromPolicy = renderTestGovernanceReport(reportWithDecision({ verdict: "PASS", findings: [] }), []);
    expect(fromPolicy).toContainEqual("- 策略裁决: PASS（仅基于已收集的 finding）");
  });

  /**
   * D-G4（2026-09-25，项目所有者批准）：覆盖非 available 时 verdict 仍是 PASS，
   * 免责必须落在裁决行本身——"上一行已写 UNAVAILABLE"不足以避免 PASS ≠ clean 陷阱。
   */
  it("marks the verdict line as not-fully-evaluated when coverage is unavailable", () => {
    const report = reportWithDecision({ verdict: "PASS", findings: [] });
    const withUnavailable = {
      ...report,
      collection: {
        ...report.collection,
        coverage: { ...report.collection.coverage, status: "unavailable", reasons: ["no_active_provider"] },
      },
    } as unknown as TestGovernanceReport;
    const lines = renderTestGovernanceReport(withUnavailable, []);
    expect(lines).toContainEqual(expect.stringContaining("未评估全部测试：no_active_provider"));
    expect(lines).toContainEqual(expect.stringContaining("PASS 不代表 clean"));
    // WARN/BLOCK 时不加 PASS 免责语，但仍标未评估
    const warn = renderTestGovernanceReport({ ...withUnavailable, decision: { ...withUnavailable.decision, verdict: "WARN" } } as unknown as TestGovernanceReport, []);
    expect(warn).toContainEqual(expect.stringContaining("未评估全部测试：no_active_provider"));
    expect(warn.some((line) => line.includes("PASS 不代表 clean"))).toBe(false);
  });

  /**
   * D-G3（2026-09-25，项目所有者批准）：spans 明细按需投影，默认不出现；
   * availability 非 available 时只给计数、绝不伪造明细。
   */
  it("projects test-case spans only under --spans and never fakes details", () => {
    const span = { file: "tests/a.test.ts", providerId: "typescript-vitest", name: "first", startLine: 3, endLine: 7, statuses: [] };
    const withSpans = reportWithDecision({ verdict: "PASS", findings: [] });
    const report = {
      ...withSpans,
      collection: { ...withSpans.collection, testCaseSpans: { availability: "available", value: [span] } },
    } as unknown as TestGovernanceReport;
    expect(testGovernanceJsonValue(report).collection.testCaseSpans).toEqual({ availability: "available" });
    const projected = testGovernanceJsonValue(report, { spans: true }).collection.testCaseSpans;
    expect(projected.spanCount).toBe(1);
    expect(projected.value).toEqual([span]);

    const unavailable = {
      ...report,
      collection: { ...report.collection, testCaseSpans: { availability: "unavailable", reason: "没有启用 test provider。" } },
    } as unknown as TestGovernanceReport;
    const noSpans = testGovernanceJsonValue(unavailable, { spans: true }).collection.testCaseSpans;
    expect(noSpans.spanCount).toBe(0);
    expect(noSpans).not.toHaveProperty("value");
  });
});

/** 缺陷 2（2026-09-25）：TEST_BLOAT 的不可测因子必须报 UNAVAILABLE 而非 0，
 *  分数按可用权重重归一化，证据带块级定位并投影进 --json，且始终 report-only。 */
const reportWithBloat = (bloat: ReturnType<typeof bloatFixture>): TestGovernanceReport => ({
  ...reportWithDecision({ verdict: "PASS", findings: [] }),
  bloat,
} as unknown as TestGovernanceReport);

describe("TEST_BLOAT availability（缺陷 2：UNAVAILABLE ≠ 0 + 重归一化 + JSON 证据）", () => {
  it("projects availability, renormalized score and block-level evidence into --json", () => {
    const json = testGovernanceJsonValue(reportWithBloat(bloatFixture({ triggered: true, unavailable: true })));
    const bloat = json.bloat!;
    expect(bloat.score).toBe(0.8);
    expect(bloat.triggered).toBe(true);
    expect(bloat.availableWeight).toBe(0.5); // 重归一化分母只含可用因子

    const [available, unavailable] = bloat.parts;
    expect(available).toMatchObject({ name: "codeSimilarityRatio", value: 1.25, contribution: 0.3, availability: "AVAILABLE", triggered: true });
    expect(unavailable).toMatchObject({ name: "fixtureBoilerplateRatio", availability: "UNAVAILABLE", reason: "language_not_supported_by_pattern", triggered: false });
    // 不可测因子绝不投影 value/contribution（serialize unavailable as 0 是宪法 §3 禁止的）
    expect(Object.keys(unavailable!)).not.toContain("value");
    expect(Object.keys(unavailable!)).not.toContain("contribution");

    expect(bloat.evidence[0]).toEqual({
      factor: "codeSimilarityRatio",
      file: "src/test/java/com/example/OrderServiceTest.java",
      value: 45,
      detail: "与其它文件共享相似块 45 行",
      startLine: 25,
      endLine: 32,
      sample: "@BeforeEach\nvoid setUp() {",
    });
  });

  it("renders UNAVAILABLE (never 0.000) for unmeasurable factors and keeps the Top-3 evidence shape", () => {
    const lines = renderTestGovernanceReport(reportWithBloat(bloatFixture({ triggered: true, unavailable: true })), []);
    const row = lines.find((line) => line.trimStart().startsWith("fixtureBoilerplateRatio"))!;
    expect(row).toContain("UNAVAILABLE");
    expect(row).not.toContain("0.000");
    expect(lines).toContainEqual(expect.stringContaining("不可测因子（UNAVAILABLE，不计入归一化分母）:"));
    expect(lines).toContainEqual(expect.stringContaining("language_not_supported_by_pattern"));
    // 证据仍是文件级 Top-3，且带块级行范围 + 样本文本
    expect(lines).toContainEqual(expect.stringContaining("src/test/java/com/example/OrderServiceTest.java L25-32"));
    expect(lines).toContainEqual(expect.stringContaining("/ Σ wᵢ(可用)"));
  });

  it("renders the DRY/DAMP boundary by case-body scope and never counts test-body duplication as chargeable", () => {
    const lines = renderTestGovernanceReport(reportWithBloat(bloatFixture({ unavailable: true })), []);
    // 计分侧与被排除侧并排：用例体内与断言语义重复都明确标注"不计分"
    expect(lines).toContainEqual(expect.stringContaining("装配(用例体外) 0.040 + 未分类 0.110 = codeSimilarityRatio 1.250"));
    expect(lines).toContainEqual(expect.stringContaining("用例体内 0.030 + 断言语义重复 0.090（DAMP 侧，不计分，不该为它抽 helper）"));
    // 三条边界事实：用例体证据可用性、未识别出用例的文件、块语义证据缺失
    expect(lines).toContainEqual(expect.stringContaining("用例体证据: PARTIAL"));
    expect(lines).toContainEqual(expect.stringContaining("未识别出用例的文件: 1 个"));
    expect(lines).toContainEqual(expect.stringContaining("块语义证据缺失: 2 个文件"));
    expect(lines).toContainEqual(expect.stringContaining("事实边界"));

    const json = testGovernanceJsonValue(reportWithBloat(bloatFixture({ unavailable: true })));
    expect(json.bloat!.similarityBuckets).toEqual({
      assemblyRatio: 0.04, unclassifiedRatio: 0.11, assertionRatio: 0.09, caseBodyRatio: 0.03,
      filesWithoutBlockEvidence: 2, filesWithoutCaseSpans: 1, caseSpansAvailability: "partial",
    });
  });

  it("keeps TEST_BLOAT report-only: a triggered signal changes no verdict, decision or exit code", () => {
    const quiet = testGovernanceJsonValue(reportWithBloat(bloatFixture()));
    const loud = testGovernanceJsonValue(reportWithBloat(bloatFixture({ triggered: true, unavailable: true })));

    expect(quiet.bloat!.triggered).toBe(false);
    expect(loud.bloat!.triggered).toBe(true);
    expect(loud.verdict).toBe("PASS");
    expect(loud.decision).toEqual(quiet.decision);
    expect(loud.decision.triggered).toEqual([]);
    expect(exitCodeOf(loud.verdict)).toBe(exitCodeOf(quiet.verdict));
    expect(exitCodeOf(quiet.verdict)).toBe(0);
    // 观察面在 bloat 节内，不进裁决面
    expect(Object.keys(loud.decision)).not.toContain("bloat");
    expect(Object.keys(loud)).toContain("bloat");
  });

  /**
   * 语言形状契约（§6/Q1，2026-09-27）：报告必须**披露**弱断言判据用的是"项目声明"还是
   * "内置默认"。该字段是可选追加（缺省不出现 ⇒ 旧消费方与旧快照不变，schema 不 bump），
   * 且只进观察面（`bloat`），不改变裁决。
   */
  it("discloses which weak-assertion list is in effect, additively and without touching the verdict", () => {
    const withShape = reportWithBloat({ ...bloatFixture(), weakAssertionShapesSource: "project" } as ReturnType<typeof bloatFixture>);
    const lines = renderTestGovernanceReport(withShape, []);
    expect(lines).toContainEqual(expect.stringContaining("弱断言名单: 项目声明"));
    expect(lines).toContainEqual(expect.stringContaining("不随形状走"));
    // 披露行**不得手抄阈值**：阈值唯一权威是同一节下表里的 `Tᵢ` 列（`parts[].threshold`）。
    // `weakAssertionRatio` 的重校准仍在待办里，手抄一个数字会在重校准当天变成
    // "一句与事实不符的陈述"——这正是本批整改的缺陷类别。
    const disclosure = lines.find((line) => line.includes("弱断言名单:"))!;
    expect(disclosure).not.toMatch(/\d+\.\d+/);

    const json = testGovernanceJsonValue(withShape);
    expect(json.bloat!.weakAssertionShapesSource).toBe("project");
    expect(json.verdict).toBe("PASS");

    // F-A（2026-09-27 独立复验）：`builtin` 只表示"**被测语言**没有项目声明"，不得写成
    // "项目未声明 shapes"——多语言仓库可能声明了另一个语言，那会是一句与事实不符的陈述
    // （实测：声明 `shapes.python` 时报告曾打印"内置默认（未声明 shapes）"）。
    const builtin = reportWithBloat({ ...bloatFixture(), weakAssertionShapesSource: "builtin" } as ReturnType<typeof bloatFixture>);
    const builtinLine = renderTestGovernanceReport(builtin, []).find((line) => line.includes("弱断言名单:"))!;
    expect(builtinLine).toContain("未声明被测语言的 shapes");
    expect(builtinLine).not.toContain("未声明 shapes）");

    // 未披露（未声明/无可测语言绑定文件）时字段缺席，json 与文本都不出现该行。
    const undeclared = reportWithBloat(bloatFixture());
    expect(testGovernanceJsonValue(undeclared).bloat!.weakAssertionShapesSource).toBeUndefined();
    expect(renderTestGovernanceReport(undeclared, []).some((line) => line.includes("弱断言名单:"))).toBe(false);
  });
});
