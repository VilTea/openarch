// 测试治理用例：provider/脚本发现事实 → 统一策略裁决 → 回写测试 metrics。
import { Effect } from "effect";
import type { IoError } from "../errors/errors";
import { ParserService } from "../port/ParserService";
import { StorageService } from "../port/StorageService";
import { evaluateTestPolicy, unbaselinedOf, type TestCaseSpanFact, type TestFinding, type TestPolicy } from "../domain/testGovernance";
import { participatesInPopulation } from "../domain/fileParticipation";
import type { FactResult } from "../script-runtime/projectFacts";
import { assessTestGovernanceCoverage, type TestGovernanceCoverage } from "../domain/testGovernanceCoverage";
import { assessTestProviderCoverage, type TestProviderCoverage } from "../domain/testProviderCoverage";
import { summarizeTestFacts, type TestProviderSummary } from "../domain/testFacts";
import type { TestModuleAssociation } from "../domain/testAssociations";
import { projectRoot, toAbsolute, toRelative } from "../infra/paths";
import { collectProviderFacts } from "./testGovernanceCollection";
import { executeTestFindingScript } from "../test-governance/engine";
import type { ProjectTestExecution } from "../test-governance/runner";
import { loadScriptFacts } from "./scriptFacts";
import { requestedScriptCapabilities } from "../script-runtime/scriptRequirements";
import { discoverProjectTestFiles, loadTestGovernanceConfiguration, selectTestGovernanceAdapters, suggestTestGovernanceAdapters, testGovernanceRulePaths, type TestGovernanceAdapterSuggestion } from "./testGovernanceSetup";
import { readProjectFileKindRules, readProjectLanguages } from "../projectFiles";
import { createAnalysisScope } from "../domain/analysisScope";
import { baselineCompatibilityOf } from "./baselineCompatibility";
import { currentFileMetrics } from "./currentMetrics";
import { testBloatMetrics, type TestBloatMetrics } from "./testBloatMetrics";
import { languageShapeErrorsText, projectShapesOfRead } from "./projectShapes";
import { readProjectConfig, projectConfigPath } from "../projectFiles";


/** Policy outcome. A PASS remains meaningful only with its collection evidence. */
export interface TestGovernanceDecision {
  readonly verdict: "PASS" | "WARN" | "BLOCK";
  readonly findings: readonly TestFinding[];
  readonly triggered: readonly { finding: TestFinding; level: "block" | "warn" }[];
  readonly exempted: readonly TestFinding[];
  readonly errors: readonly string[];
}

/** Static collection scope and provider-derived facts. */
export interface TestGovernanceCollectionEvidence {
  readonly coverage: TestGovernanceCoverage;
  readonly providerCoverage: readonly TestProviderCoverage[];
  readonly testFiles: number;
  readonly providersRun: readonly string[];
  readonly providerSummaries: readonly TestProviderSummary[];
  readonly testCaseSpans: FactResult<readonly TestCaseSpanFact[]>;
  readonly staticModuleAssociations: readonly { readonly testFile: string; readonly association: TestModuleAssociation }[];
  readonly associationUnavailableTestFiles: readonly string[];
  readonly unrecognizedTestFiles: readonly string[];
  /** 无启用 provider 时按检测语言给出的候选适配器；只建议，不自动启用。 */
  readonly suggestedAdapters?: TestGovernanceAdapterSuggestion;
}

/** Framework execution is intentionally separate from AST-derived quality facts. */
export interface TestGovernanceExecutionEvidence {
  readonly runnersRun: readonly string[];
  readonly executions: readonly { readonly providerId: string; readonly execution: ProjectTestExecution }[];
}

/** Project-script execution evidence does not belong to provider collection. */
export interface TestGovernanceScriptEvidence {
  readonly scriptUnavailable: readonly string[];
  readonly scriptPruning: readonly { readonly rule: string; readonly inputFiles: number; readonly targetFiles: number; readonly candidateFiles: number; readonly records: number }[];
}

export interface TestGovernanceReport {
  readonly decision: TestGovernanceDecision;
  readonly collection: TestGovernanceCollectionEvidence;
  readonly execution: TestGovernanceExecutionEvidence;
  readonly scripts: TestGovernanceScriptEvidence;
  /** 测试膨胀指标（静态可算：语法分析 + 块级 minhash 相似度 + git 事实），
   *  仅 includeBloat 时计算——信号 TEST_BLOAT 提醒 agent 开始治理（校准 2026-08-08）。 */
  readonly bloat?: TestBloatMetrics;
}

/**
 * `unbaselinedOf` 的权威实现已下沉到 `domain/testGovernance`（D-G18：provider 采集也消费它，
 * 而 domain 是它唯一无环的归属）。这里保持转出，`@openarch/core` 的公开入口不变。
 */
export { unbaselinedOf };

/**
 * 供 `check` 使用的轻量入口：只读 canonical baseline 分片与项目测试文件总体，
 * 不做 provider 采集、不执行 runner、不写回任何事实。
 */
export const unbaselinedTestFiles = (
  options: { readonly discoveredTestFiles?: readonly string[] } = {},
) =>
  Effect.gen(function* () {
    const storage = yield* StorageService;
    const canonical = storage.listCurrentFileMetrics ? yield* storage.listAllFileMetrics() : yield* currentFileMetrics(storage);
    const baselineTestPaths = canonical
      .filter(([, entry]) => participatesInPopulation(entry.fileKind, "test-governance"))
      .map(([path]) => path);
    const discovered = [...new Set((options.discoveredTestFiles ?? discoverProjectTestFiles()).map(toAbsolute))].sort();
    return unbaselinedOf(discovered, baselineTestPaths).map((path) => toRelative(path));
  });

export interface TestGovernanceOptions {
  /** 嵌入式调用可显式传策略，CLI 缺省从项目 config 读取。 */
  readonly policy?: TestPolicy;
  readonly providerIds?: readonly string[];
  readonly runnerIds?: readonly string[];
  readonly rules?: readonly string[];
  /** Embedded callers may supply the current project test set instead of reading the filesystem. */
  readonly discoveredTestFiles?: readonly string[];
  /** @deprecated 校准 2026-08-15：testMetrics 持久化已退役，测试治理恒为只读采集；保留字段只为旧调用兼容。 */
  readonly persistence?: "read" | "write";
  /** 计算测试膨胀指标（遍历测试文件做语法查询 + 块级 minhash——默认关闭避免常规调用成本）。 */
  readonly includeBloat?: boolean;
}

const testCaseSpanFacts = (
  files: readonly string[],
  providerCount: number,
  collection: { readonly testCaseSpans: readonly TestCaseSpanFact[]; readonly providerHandledTestFiles: readonly string[]; readonly unrecognizedTestFiles: readonly string[]; readonly failedTestFiles: readonly string[] },
): FactResult<readonly TestCaseSpanFact[]> => {
  if (providerCount === 0) return { availability: "unavailable", reason: "没有启用 test provider。" };
  // D-G9（2026-09-25 跨语言核实，`vue3-vitesse`）：候选集为空时 `Array.every` 是**空真**，
  // 于是"没有任何 provider 运行过"被报成 `available`（值为空数组），报告打印
  // `Test-case spans: AVAILABLE` 却 0 条事实——把"没评估"伪装成"评估了且为空"。
  // 空候选集不是"已证实为空"，而是"没有可采集的对象"：如实报 unavailable 并指出原因。
  // D-G18 起候选集来自实时发现（不再是 baseline 条目），所以本分支只在"没有任何已启用
  // provider 声明支持这些文件"时命中；候选存在时由下面的 complete 判定负责。
  if (files.length === 0) {
    return { availability: "unavailable", reason: "没有可采集的测试文件（没有已启用 provider 声明支持当前发现的文件）。" };
  }
  const handled = new Set(collection.providerHandledTestFiles);
  const complete = files.every((file) => handled.has(file))
    && collection.unrecognizedTestFiles.length === 0
    && collection.failedTestFiles.length === 0;
  return {
    availability: complete ? "available" : "partial",
    value: collection.testCaseSpans,
    ...(complete ? {} : { reason: "当前测试范围存在未识别或 provider 采集失败文件。" }),
  };
};

export const testGovernance = (options: TestGovernanceOptions = {}) =>
  Effect.gen(function* () {
    const parser = yield* ParserService;
    const storage = yield* StorageService;
    const run = () => Effect.gen(function* () {
    const configured = loadTestGovernanceConfiguration();
    const policy = options.policy ?? configured.policy;
    const providerIds = options.providerIds ?? configured.providerIds;
    const runnerIds = options.runnerIds ?? configured.runnerIds;
    const coverageConfigured = configured.configured || options.policy !== undefined || options.providerIds !== undefined || options.runnerIds !== undefined || options.rules !== undefined;
    const selectionErrors: string[] = [];
    // D-G12：配置无法解析时**必须**是配置错误，而不是"未配置"。差别不是措辞：
    // 前者说明项目的事实基础（languages/policies）全部不可信，后者只是没启用测试治理。
    if (configured.configError) selectionErrors.push(configured.configError);
    // 语言形状（§6）：读取走唯一权威 `projectShapes`（内部仍只经 `readProjectConfig`）。
    // **声明错误必须上报**（fail-closed）：一份不可用的声明既不能当"已声明"（判据没变）
    // 也不能当"未声明"（身份宣称了形状）——静默继续就是"身份变了、事实没变"的不一致。
    const shapesRead = projectShapesOfRead(readProjectConfig(projectConfigPath(projectRoot())));
    if (shapesRead.errors.length > 0) selectionErrors.push(`shapes 声明不可用: ${languageShapeErrorsText(shapesRead.errors)}`);
    const shapes = shapesRead.byLanguage;
    const selection = selectTestGovernanceAdapters(providerIds, runnerIds);
    selectionErrors.push(...selection.errors);
    const selectedProviders = selection.providers;
    const selectedRunners = selection.runners;
    const executions = yield* Effect.forEach(selectedRunners, (runner) =>
      Effect.promise(() => runner.run(projectRoot())).pipe(Effect.map((execution) => ({ providerId: runner.id, execution }))),
    );

    const entries = yield* currentFileMetrics(storage);
    // Canonical baseline entries remain the only durable test-file population
    // for missing-baseline detection. testMetrics 持久化已退役（校准 2026-08-15）：
    // 测试治理恒为只读采集，不再把 provider 事实写回 canonical 分片。
    const canonicalEntries = storage.listCurrentFileMetrics
      ? yield* storage.listAllFileMetrics()
      : entries;
    const testEntries = entries.filter(([, entry]) => participatesInPopulation(entry.fileKind, "test-governance"));
    const canonicalTestEntries = canonicalEntries.filter(([, entry]) => participatesInPopulation(entry.fileKind, "test-governance"));
    const discoveredTestFiles = [...new Set((options.discoveredTestFiles ?? discoverProjectTestFiles()).map(toAbsolute))].sort();
    const baselineTestPaths = canonicalTestEntries.map(([path]) => path);
    const unbaselinedTestFiles = unbaselinedOf(discoveredTestFiles, baselineTestPaths);
    const productionPaths = new Set(entries
      .filter(([, entry]) => participatesInPopulation(entry.fileKind, "production-governance"))
      .map(([path]) => toAbsolute(path)));
    // 项目脚本的范围仍是 baseline 测试总体（D-G18 只改 provider 采集面）：
    // 脚本事实里的 `baseline` 对账对象与扫描范围必须一致，越界会让脚本看到"悬浮"文件。
    const scriptScopeFiles = testEntries.map(([path]) => path);
    // provider 采集范围 = 实时发现的测试文件（D-G18），与 bloat 同一口径；
    // `unbaselinedTestFiles` 只是同一判据的另一处消费（覆盖与 CLI 提示）。
    const collection = yield* collectProviderFacts(parser, discoveredTestFiles, baselineTestPaths, selectedProviders, productionPaths);
    const findings: TestFinding[] = [...collection.findings];
    const errors = [...selectionErrors, ...collection.errors, ...executions.filter(({ execution }) => !execution.passed)
      .map(({ providerId, execution }) => `${providerId}: ${execution.command}: ${execution.detail ?? "failed"}`)];
    const scriptUnavailable: string[] = [];
    const scriptPruning: Array<{ rule: string; inputFiles: number; targetFiles: number; candidateFiles: number; records: number }> = [];

    const testCaseSpans = testCaseSpanFacts(discoveredTestFiles, selectedProviders.length, collection);
    const index = yield* storage.readIndex().pipe(Effect.catchAll(() => Effect.succeed(null)));
    // D-G8③ + §6/Q2：与 gate/status 共用同一兼容性权威（比较与字段映射都不在这里重写）；
    // 该权威同时消费 scope 与 shapes，两种不兼容在这里各自成判据。
    const compatibility = baselineCompatibilityOf(
      index,
      createAnalysisScope(readProjectLanguages(projectRoot()), readProjectFileKindRules(projectRoot())).fingerprint,
      shapesRead.fingerprint,
    );
    const baselineScopeIncompatible = compatibility.reason === "baseline_scope_incompatible";
    const baselineShapesIncompatible = compatibility.reason === "baseline_shapes_incompatible";
    const scriptPaths = options.rules ?? testGovernanceRulePaths();
    const requestedCapabilities = yield* Effect.promise(() => requestedScriptCapabilities(scriptPaths));
    const facts = yield* loadScriptFacts({ files: scriptScopeFiles, baseline: { entries: new Map(entries), index }, testCaseSpans, requestedCapabilities });
    for (const path of scriptPaths) {
      const result = yield* Effect.promise(() => executeTestFindingScript(path, scriptScopeFiles, parser, { facts }));
      findings.push(...result.findings);
      if (result.error) errors.push(result.error);
      if (result.unavailable) scriptUnavailable.push(`${path}: ${result.unavailable}`);
      if (result.stages) scriptPruning.push({
        rule: path,
        inputFiles: result.stages.inputFiles,
        targetFiles: result.stages.targetFiles.length,
        candidateFiles: result.stages.candidateFiles.length,
        records: result.stages.records.length,
      });
    }
    const policyResult = evaluateTestPolicy(findings, policy);
    const verdict = errors.length > 0 ? "BLOCK" : policyResult.verdict;
    const suggestedAdapters = selectedProviders.length === 0
      ? suggestTestGovernanceAdapters(readProjectLanguages(projectRoot()))
      : undefined;
    const coverage = assessTestGovernanceCoverage({
      configured: coverageConfigured,
      activeProviderCount: selectedProviders.length,
      testFiles: discoveredTestFiles,
      unbaselinedTestFiles,
      providerHandledTestFiles: collection.providerHandledTestFiles,
      unrecognizedTestFiles: collection.unrecognizedTestFiles,
      failedTestFiles: collection.failedTestFiles,
      // D-G8③：判据来自共享权威 `baselineCompatibility`（与 gate/status 同一实现）。
      // 只把 **范围不兼容** 这一条带进测试覆盖：缺索引由 `test_files_missing_from_baseline`
      // 表达，度量契约不兼容对只读的 provider 采集影响有限（由 `check`/`context` 报）。
      ...(baselineScopeIncompatible ? { baselineScopeCompatible: false } : {}),
      // §6/Q2：形状身份不兼容同样降级为 `partial`——判断口径已变（哪些调用算弱断言），
      // 而 baseline 的测试事实是旧声明下采集的。原因码独立可读，不并进范围不兼容。
      ...(baselineShapesIncompatible ? { baselineShapesCompatible: false } : {}),
    });
    // provider 覆盖口径由采集侧给出（候选/未入 baseline/已处理/失败都按 provider.supports 过滤），
    // 这里只做纯裁决——不再在应用层重做一次 `unbaselinedTestFiles.filter(supports)`。
    const providerCoverage = collection.providerCoverageInputs
      .map((input) => assessTestProviderCoverage(input))
      .sort((a, b) => a.providerId.localeCompare(b.providerId));
    const bloat: TestBloatMetrics | undefined = options.includeBloat
      ? yield* Effect.promise(() => testBloatMetrics(projectRoot(), discoveredTestFiles, parser, {
        availability: testCaseSpans.availability,
        ...(testCaseSpans.availability === "unavailable" ? { reason: testCaseSpans.reason } : {}),
        // 用例体来自 provider（`test-case-spans` 唯一权威）：bloat 只消费，不自行解析框架语法。
        spans: (testCaseSpans.availability === "unavailable" ? [] : testCaseSpans.value ?? [])
          .map((span) => ({ file: span.file, startLine: span.startLine, endLine: span.endLine })),
      }, shapes))
      : undefined;
    return {
      decision: { verdict, findings, triggered: policyResult.triggered, exempted: policyResult.exempted, errors },
      collection: {
        coverage, providerCoverage, testFiles: discoveredTestFiles.length, providersRun: selectedProviders.map((provider) => provider.id),
        providerSummaries: summarizeTestFacts(collection.collectedFacts), testCaseSpans, unrecognizedTestFiles: [...collection.unrecognizedTestFiles].sort(),
        staticModuleAssociations: [...collection.staticModuleAssociations].sort((a, b) => a.testFile.localeCompare(b.testFile) || a.association.targetPath.localeCompare(b.association.targetPath)),
        associationUnavailableTestFiles: [...collection.associationUnavailableTestFiles].sort(),
        ...(suggestedAdapters ? { suggestedAdapters } : {}),
      },
      execution: { runnersRun: selectedRunners.map((runner) => runner.id), executions },
      scripts: { scriptUnavailable, scriptPruning },
      ...(bloat ? { bloat } : {}),
    } as TestGovernanceReport;
    });
    return yield* run();
  });
