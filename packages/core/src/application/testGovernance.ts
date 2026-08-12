// 测试治理用例：provider/脚本发现事实 → 统一策略裁决 → 回写测试 metrics。
import { Effect } from "effect";
import { ParserService } from "../port/ParserService";
import { StorageService } from "../port/StorageService";
import { evaluateTestPolicy, type TestCaseSpanFact, type TestFinding, type TestPolicy } from "../domain/testGovernance";
import { participatesInPopulation } from "../domain/fileParticipation";
import type { FactResult } from "../script-runtime/projectFacts";
import { assessTestGovernanceCoverage, type TestGovernanceCoverage } from "../domain/testGovernanceCoverage";
import { assessTestProviderCoverage, type TestProviderCoverage } from "../domain/testProviderCoverage";
import { summarizeTestFacts, type TestProviderSummary } from "../domain/testFacts";
import type { TestModuleAssociation } from "../domain/testAssociations";
import { projectRoot, toAbsolute, toPosixPath } from "../infra/paths";
import { collectProviderFacts } from "./testGovernanceCollection";
import { executeTestFindingScript } from "../test-governance/engine";
import type { ProjectTestExecution } from "../test-governance/runner";
import { loadScriptFacts } from "./scriptFacts";
import { requestedScriptCapabilities } from "../script-runtime/scriptRequirements";
import { discoverProjectTestFiles, loadTestGovernanceConfiguration, selectTestGovernanceAdapters, testGovernanceRulePaths } from "./testGovernanceSetup";
import { currentFileMetrics } from "./currentMetrics";
import { withGovernanceWriteLock } from "./governance/writeLock";
import { testBloatMetrics, type TestBloatMetrics } from "./testBloatMetrics";


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

export interface TestGovernanceOptions {
  /** 嵌入式调用可显式传策略，CLI 缺省从项目 config 读取。 */
  readonly policy?: TestPolicy;
  readonly providerIds?: readonly string[];
  readonly runnerIds?: readonly string[];
  readonly rules?: readonly string[];
  /** Embedded callers may supply the current project test set instead of reading the filesystem. */
  readonly discoveredTestFiles?: readonly string[];
  /** `read` reports freshly collected facts without mutating the baseline. */
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
    const persist = options.persistence !== "read";
    const run = () => Effect.gen(function* () {
    const configured = loadTestGovernanceConfiguration();
    const policy = options.policy ?? configured.policy;
    const providerIds = options.providerIds ?? configured.providerIds;
    const runnerIds = options.runnerIds ?? configured.runnerIds;
    const coverageConfigured = configured.configured || options.policy !== undefined || options.providerIds !== undefined || options.runnerIds !== undefined || options.rules !== undefined;
    const selectionErrors: string[] = [];
    const selection = selectTestGovernanceAdapters(providerIds, runnerIds);
    selectionErrors.push(...selection.errors);
    const selectedProviders = selection.providers;
    const selectedRunners = selection.runners;
    const executions = yield* Effect.forEach(selectedRunners, (runner) =>
      Effect.promise(() => runner.run(projectRoot())).pipe(Effect.map((execution) => ({ providerId: runner.id, execution }))),
    );

    const entries = yield* currentFileMetrics(storage);
    const testEntries = entries.filter(([, entry]) => participatesInPopulation(entry.fileKind, "test-governance"));
    const discoveredTestFiles = [...new Set((options.discoveredTestFiles ?? discoverProjectTestFiles()).map(toAbsolute))].sort();
    const baselineTestFiles = new Set(testEntries.map(([path]) => toAbsolute(path)));
    const unbaselinedTestFiles = discoveredTestFiles.filter((path) => !baselineTestFiles.has(path));
    const productionPaths = new Set(entries
      .filter(([, entry]) => participatesInPopulation(entry.fileKind, "production-governance"))
      .map(([path]) => toPosixPath(path)));
    const files = testEntries.map(([path]) => path);
    const collection = yield* collectProviderFacts(parser, storage, testEntries, selectedProviders, productionPaths, { persist });
    const findings: TestFinding[] = [...collection.findings];
    const errors = [...selectionErrors, ...collection.errors, ...executions.filter(({ execution }) => !execution.passed)
      .map(({ providerId, execution }) => `${providerId}: ${execution.command}: ${execution.detail ?? "failed"}`)];
    const scriptUnavailable: string[] = [];
    const scriptPruning: Array<{ rule: string; inputFiles: number; targetFiles: number; candidateFiles: number; records: number }> = [];

    const testCaseSpans = testCaseSpanFacts(files, selectedProviders.length, collection);
    const index = yield* storage.readIndex().pipe(Effect.catchAll(() => Effect.succeed(null)));
    const scriptPaths = options.rules ?? testGovernanceRulePaths();
    const requestedCapabilities = yield* Effect.promise(() => requestedScriptCapabilities(scriptPaths));
    const facts = yield* loadScriptFacts({ files, baseline: { entries: new Map(entries), index }, testCaseSpans, requestedCapabilities });
    for (const path of scriptPaths) {
      const result = yield* Effect.promise(() => executeTestFindingScript(path, files, parser, { facts }));
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
    const coverage = assessTestGovernanceCoverage({
      configured: coverageConfigured,
      activeProviderCount: selectedProviders.length,
      testFiles: discoveredTestFiles,
      unbaselinedTestFiles,
      providerHandledTestFiles: collection.providerHandledTestFiles,
      unrecognizedTestFiles: collection.unrecognizedTestFiles,
      failedTestFiles: collection.failedTestFiles,
    });
    const providerCoverage = collection.providerCoverageInputs
      .map((input) => {
        const provider = selectedProviders.find((candidate) => candidate.id === input.providerId);
        return assessTestProviderCoverage({
          ...input,
          unbaselinedTestFiles: provider ? unbaselinedTestFiles.filter((path) => provider.supports(path)) : [],
        });
      })
      .sort((a, b) => a.providerId.localeCompare(b.providerId));
    const bloat: TestBloatMetrics | undefined = options.includeBloat
      ? yield* Effect.promise(() => testBloatMetrics(projectRoot(), discoveredTestFiles, parser))
      : undefined;
    return {
      decision: { verdict, findings, triggered: policyResult.triggered, exempted: policyResult.exempted, errors },
      collection: {
        coverage, providerCoverage, testFiles: discoveredTestFiles.length, providersRun: selectedProviders.map((provider) => provider.id),
        providerSummaries: summarizeTestFacts(collection.collectedFacts), testCaseSpans, unrecognizedTestFiles: [...collection.unrecognizedTestFiles].sort(),
        staticModuleAssociations: [...collection.staticModuleAssociations].sort((a, b) => a.testFile.localeCompare(b.testFile) || a.association.targetPath.localeCompare(b.association.targetPath)),
        associationUnavailableTestFiles: [...collection.associationUnavailableTestFiles].sort(),
      },
      execution: { runnersRun: selectedRunners.map((runner) => runner.id), executions },
      scripts: { scriptUnavailable, scriptPruning },
      ...(bloat ? { bloat } : {}),
    } as TestGovernanceReport;
    });
    return yield* persist
      ? withGovernanceWriteLock(process.env.OPENARCH_AGENT_ID ?? "test", run)
      : run();
  });
