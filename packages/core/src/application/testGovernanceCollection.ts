import { Effect } from "effect";
import { unbaselinedOf, type TestCaseSpanFact, type TestFinding } from "../domain/testGovernance";
import type { CollectedTestFacts } from "../domain/testFacts";
import type { TestModuleAssociation } from "../domain/testAssociations";
import type { TestProviderCoverageInput } from "../domain/testProviderCoverage";
import { resolveTestModuleAssociations } from "./testAssociationResolver";
import { resolveCrossFileAssertionScope } from "../test-governance/assertionContext";
import type { TestFrameworkProvider } from "../test-governance/provider";
import type { ParserService } from "../port/ParserService";

export interface ProviderCollection {
  readonly findings: readonly TestFinding[];
  readonly testCaseSpans: readonly TestCaseSpanFact[];
  readonly collectedFacts: readonly CollectedTestFacts[];
  readonly providerCoverageInputs: readonly TestProviderCoverageInput[];
  readonly providerHandledTestFiles: readonly string[];
  readonly unrecognizedTestFiles: readonly string[];
  readonly failedTestFiles: readonly string[];
  readonly staticModuleAssociations: readonly { readonly testFile: string; readonly association: TestModuleAssociation }[];
  readonly associationUnavailableTestFiles: readonly string[];
  readonly errors: readonly string[];
}

/**
 * Runs framework-specific collection. testMetrics 持久化已退役（校准 2026-08-15），
 * 本函数与写入 canonical 分片解耦，测试治理恒为只读采集。
 *
 * **采集范围（D-G18，2026-09-25 项目所有者批准）**：候选集是**实时发现**的测试文件
 * （`discoverProjectTestFiles()` 的结果，与 `TEST_BLOAT` 同一口径），**不是** baseline 条目。
 * 此前只采集 baseline 已存在的测试文件，于是会话内新增的测试文件在 `scan` 之前
 * 产生不了任何 provider 事实（实测 `vue3-vitesse`：可发现=3 / provider 处理=0）。
 * 未入 baseline 不再等于"没有事实"，而是 finding 上带来源标记 `unbaselined`。
 *
 * 判据只有 `unbaselinedOf` 一个入口：本函数**派生**每条 finding 的标记，
 * 不接收调用方传来的"预标记结果"，避免同一事实两处各写一份。
 */
export const collectProviderFacts = (
  parser: ParserService,
  candidateTestFiles: readonly string[],
  baselineTestPaths: Iterable<string>,
  providers: readonly TestFrameworkProvider[],
  productionPaths: ReadonlySet<string>,
) => Effect.gen(function* () {
  const findings: TestFinding[] = [];
  const testCaseSpans: TestCaseSpanFact[] = [];
  const collectedFacts: CollectedTestFacts[] = [];
  const providerHandledTestFiles: string[] = [];
  const unrecognizedTestFiles: string[] = [];
  const failedTestFiles: string[] = [];
  const staticModuleAssociations: Array<{ testFile: string; association: TestModuleAssociation }> = [];
  const associationUnavailableTestFiles: string[] = [];
  const errors: string[] = [];
  const providerCoverageInputs = new Map<string, { providerId: string; candidateTestFiles: string[]; unbaselinedTestFiles: string[]; providerHandledTestFiles: string[]; failedTestFiles: string[] }>(
    providers.map((provider) => [provider.id, { providerId: provider.id, candidateTestFiles: [], unbaselinedTestFiles: [], providerHandledTestFiles: [], failedTestFiles: [] }]),
  );
  // 未入 baseline 的候选文件（同一判据同时供 source 标记与覆盖口径使用）。
  const unbaselined = new Set(unbaselinedOf(candidateTestFiles, baselineTestPaths));
  const exportedSymbolsByPath = new Map<string, import("../domain/ast").FileAst["exportedSymbols"]>();
  // 跨文件断言包装缓存：同一 helper 文件被多个测试 import 只 parse 一次（command-scoped）。
  const crossFileWrapperCache = new Map<string, ReadonlySet<string>>();

  for (const path of candidateTestFiles) {
    const provider = providers.find((candidate) => candidate.supports(path));
    if (!provider) {
      unrecognizedTestFiles.push(path);
      continue;
    }
    const providerCoverage = providerCoverageInputs.get(provider.id)!;
    providerCoverage.candidateTestFiles.push(path);
    const unbaselinedHere = unbaselined.has(path);
    if (unbaselinedHere) providerCoverage.unbaselinedTestFiles.push(path);
    try {
      // 跨文件断言包装（2026-08-12 调研落地）：先解析测试文件 AST 拿到 import
      // 目标，再定向惰性解析 helper 模块；collect 传 context 聚合包装名。
      const parsedBeforeCollect = yield* Effect.either(parser.parse(path));
      const crossFileScope = parsedBeforeCollect._tag === "Right"
        ? yield* Effect.promise(() => resolveCrossFileAssertionScope(parser, parsedBeforeCollect.right.imports, productionPaths, crossFileWrapperCache))
        : { wrapperNamesByFile: new Map(), isWrapperCall: () => false };
      const collected = yield* Effect.promise(() => provider.collect(path, parser, {
        isCrossFileWrapperCall: crossFileScope.isWrapperCall,
      }));
      providerHandledTestFiles.push(path);
      providerCoverage.providerHandledTestFiles.push(path);
      const providerFindings = collected.findings.map((finding) => ({
        ...finding,
        source: provider.id,
        // 只对未入 baseline 的测试文件设标记：缺省即旧语义，老 finding 逐字段不变。
        ...(unbaselinedHere ? { unbaselined: true as const } : {}),
      }));
      findings.push(...providerFindings);
      testCaseSpans.push(...(collected.testCaseSpans ?? []).map((span) => ({ ...span, file: path, providerId: provider.id })));
      collectedFacts.push({ providerId: provider.id, tests: collected.tests });
      const parsed = parsedBeforeCollect;
      const moduleAssociations = parsed._tag === "Right"
        ? yield* resolveTestModuleAssociations(parser, parsed.right, productionPaths, collected.symbolCallEvidence ?? [], exportedSymbolsByPath)
        : undefined;
      if (moduleAssociations === undefined) associationUnavailableTestFiles.push(path);
      else staticModuleAssociations.push(...moduleAssociations.map((association) => ({ testFile: path, association })));
    } catch (error) {
      failedTestFiles.push(path);
      providerCoverage.failedTestFiles.push(path);
      errors.push(`${provider.id}: ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    findings, testCaseSpans, collectedFacts, providerHandledTestFiles, unrecognizedTestFiles, failedTestFiles,
    providerCoverageInputs: [...providerCoverageInputs.values()], staticModuleAssociations, associationUnavailableTestFiles, errors,
  } satisfies ProviderCollection;
});
