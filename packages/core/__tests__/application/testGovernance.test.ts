import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { testGovernance } from "../../src/application/testGovernance";
import { suggestTestGovernanceAdapters } from "../../src/application/testGovernanceSetup";
import { ParserService } from "../../src/port/ParserService";
import { StorageService } from "../../src/port/StorageService";
import { LockService } from "../../src/port/LockService";
import { toAbsolute } from "../../src/infra/paths";
import { createAnalysisScope } from "../../src/domain/analysisScope";
import { METRIC_CONTRACT_VERSION } from "../../src/domain/metricCatalog";
import { readProjectLanguages } from "../../src/projectFiles";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

describe("testGovernance adapter suggestions", () => {
  it("maps detected languages to candidates without auto-enabling them", () => {
    expect(suggestTestGovernanceAdapters(["typescript", "go"])).toEqual({
      providers: ["typescript-vitest", "go-testing"],
      runners: ["node-test"],
    });
    expect(suggestTestGovernanceAdapters(["unknown-language"])).toBeUndefined();
  });
});

describe("testGovernance application", () => {
  /**
   * D-G18（2026-09-25 项目所有者批准）：provider 采集范围从 **baseline 条目**改为
   * **实时发现的测试文件**，未入 baseline 的 finding 带来源标记 `unbaselined: true`。
   * 本用例是这次口径变化的主证据：`new.test.ts` 不在 canonical baseline 里，
   * 但它现在有 provider finding，且该 finding 被标记。
   */
  it("keeps provider facts and policy verdicts separate in read-only reporting mode", async () => {
    // D-G18 起 provider 采集的是 `discoverProjectTestFiles()` 的结果，那是**绝对路径**，
    // 因此本用例的测试文件夹具也统一走 `toAbsolute`（与生产入口同形）。
    const subjectPath = toAbsolute("packages/core/src/domain/subject.ts");
    const emptyTestPath = toAbsolute("packages/core/__tests__/empty.test.ts");
    const newTestPath = toAbsolute("packages/core/__tests__/new.test.ts");
    const goTestPath = toAbsolute("services/coordination/internal/evidence/sample_test.go");
    const written: Array<Record<string, unknown>> = [];
    const ParserTest = Layer.succeed(ParserService, {
      parse: (path) => Effect.succeed({
        path, language: "typescript" as const, branchCount: 0, nestingDepth: 0, functionCount: 0,
        passthroughCalls: 0, imports: [{ resolvedPath: subjectPath, source: "../../src/domain/subject" }], functions: [],
        exportedSymbols: [],
      }), query: () => Effect.succeed([]), supportedLanguages: Effect.succeed(["typescript"]),
    });
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: () => Effect.void, readIndex: () => Effect.succeed(null), writeIndex: () => Effect.void,
      writeFileMetrics: (_path, entry) => Effect.sync(() => { written.push(entry); }), deleteFileMetrics: () => Effect.void, readFileMetrics: () => Effect.succeed(null),
      listAllFileMetrics: () => Effect.succeed([[emptyTestPath, {
        path: emptyTestPath, fileKind: "test" as const,
        branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0,
      }], [subjectPath, {
        path: subjectPath, fileKind: "production" as const,
        branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0,
      }], [goTestPath, {
        path: goTestPath, fileKind: "test" as const,
        branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0,
      }]]),
      clearFileMetrics: () => Effect.void, writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null), readAllHistory: () => Effect.succeed([]),
    });
    const LockTest = Layer.succeed(LockService, {
      acquire: () => Effect.succeed({ name: "governance-state-write", agentId: "test", acquiredAt: 0, lockId: "test-lock" }),
      release: () => Effect.void,
    });
    const report = await Effect.runPromise(testGovernance({
      providerIds: ["typescript-vitest"], policy: { rules: {} }, rules: [],
      discoveredTestFiles: [emptyTestPath, goTestPath, newTestPath],
    }).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest))));
    expect(report.decision.verdict).toBe("PASS");
    expect(report.collection.coverage).toEqual({
      status: "partial",
      reasons: ["test_files_missing_from_baseline", "test_files_unrecognized"],
      testFiles: 3,
      unbaselinedTestFiles: [newTestPath],
      providerHandledTestFiles: [emptyTestPath, newTestPath],
      unrecognizedTestFiles: [goTestPath],
      failedTestFiles: [],
    });
    expect(report.collection.providersRun).toEqual(["typescript-vitest"]);
    // D-G18：候选集 = 实时发现中该 provider 声明支持的文件（不再只有 baseline 条目）。
    expect(report.collection.providerCoverage).toEqual([{
      providerId: "typescript-vitest",
      status: "partial",
      reasons: ["test_files_missing_from_baseline"],
      candidateTestFiles: [emptyTestPath, newTestPath],
      unbaselinedTestFiles: [newTestPath],
      providerHandledTestFiles: [emptyTestPath, newTestPath],
      failedTestFiles: [],
    }]);
    expect(report.collection.providerSummaries).toEqual([{ providerId: "typescript-vitest", testFiles: 2, testCases: 0, p95: undefined }]);
    // D-G9 的空真修复仍然有效：有候选、有 provider，只是没有用例事实 ⇒ partial（不是 available）。
    expect(report.collection.testCaseSpans).toMatchObject({ availability: "partial", value: [] });
    expect(report.collection.unrecognizedTestFiles).toEqual([goTestPath]);
    expect(report.collection.staticModuleAssociations).toEqual([
      {
        testFile: emptyTestPath,
        association: { targetPath: subjectPath, source: "../../src/domain/subject", confidence: "low" },
      },
      {
        testFile: newTestPath,
        association: { targetPath: subjectPath, source: "../../src/domain/subject", confidence: "low" },
      },
    ]);
    expect(report.collection.associationUnavailableTestFiles).toEqual([]);
    expect(written).toEqual([]);
  });

  it("retired testMetrics persistence never writes provider facts into canonical shards", async () => {
    const subjectPath = resolve("packages/core/src/domain/subject.ts").replace(/\\/g, "/");
    const canonicalTestPath = "packages/core/__tests__/empty.test.ts";
    const overlayTestPath = "packages/core/__tests__/new.test.ts";
    const written: Array<Record<string, unknown>> = [];
    const ParserTest = Layer.succeed(ParserService, {
      parse: (path) => Effect.succeed({
        path, language: "typescript" as const, branchCount: 0, nestingDepth: 0, functionCount: 0,
        passthroughCalls: 0, imports: [], functions: [],
      }), query: () => Effect.succeed([]), supportedLanguages: Effect.succeed(["typescript"]),
    });
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: () => Effect.void, readIndex: () => Effect.succeed(null), writeIndex: () => Effect.void,
      writeFileMetrics: (_path, entry) => Effect.sync(() => { written.push(entry); }), deleteFileMetrics: () => Effect.void, readFileMetrics: () => Effect.succeed(null),
      listAllFileMetrics: () => Effect.succeed([[canonicalTestPath, {
        path: canonicalTestPath, fileKind: "test" as const,
        branchCount: 7, nestingDepth: 3, inDegree: 1, outDegree: 2, alphaStruct: 0.2,
      }], [subjectPath, {
        path: subjectPath, fileKind: "production" as const,
        branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0,
      }]]),
      listCurrentFileMetrics: () => Effect.succeed([[canonicalTestPath, {
        path: canonicalTestPath, fileKind: "test" as const,
        branchCount: 9, nestingDepth: 4, inDegree: 2, outDegree: 3, alphaStruct: 0.3,
      }], [overlayTestPath, {
        path: overlayTestPath, fileKind: "test" as const,
        branchCount: 8, nestingDepth: 2, inDegree: 0, outDegree: 1, alphaStruct: 0.1,
      }], [subjectPath, {
        path: subjectPath, fileKind: "production" as const,
        branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0,
      }]]),
      clearFileMetrics: () => Effect.void, writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null), readAllHistory: () => Effect.succeed([]),
    });
    const LockTest = Layer.succeed(LockService, {
      acquire: () => Effect.succeed({ name: "governance-state-write", agentId: "test", acquiredAt: 0, lockId: "test-lock" }),
      release: () => Effect.void,
    });
    const report = await Effect.runPromise(testGovernance({
      providerIds: ["typescript-vitest"], policy: { rules: {} }, rules: [],
      discoveredTestFiles: [canonicalTestPath, overlayTestPath],
    }).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest))));
    expect(report.collection.coverage.unbaselinedTestFiles).toEqual([expect.stringMatching(/new\.test\.ts$/)]);
    expect(written).toEqual([]);
  });

  /**
   * D-G9（2026-09-25 跨语言核实，`vue3-vitesse`）：候选集为空时 `Array.every` 空真，
   * 于是"没有任何 provider 运行过"被报成 `Test-case spans: AVAILABLE`（值空数组）。
   *
   * D-G18 后该场景换了一副面孔：候选集不再为空（实时发现给出文件），provider 真的跑了，
   * 只是这些文件里没有建立任何用例体事实。结论仍是"绝不谎称有明细"——`available` 只在
   * provider 完整处理了全部候选时成立，且 `value` 如实为空数组，不伪造 span。
   * "候选集为空 ⇒ unavailable"分支现在只在没有任何已启用 provider 声明支持发现文件时命中
   * （真实应用里不可达，作为防御保留并已由 `testCaseSpanFacts` 的注释说明）。
   */
  it("keeps the case-span fact honest when providers ran but established no case body", async () => {
    const subjectPath = toAbsolute("packages/core/src/domain/subject.ts");
    const ParserTest = Layer.succeed(ParserService, {
      parse: (path) => Effect.succeed({
        path, language: "typescript" as const, branchCount: 0, nestingDepth: 0, functionCount: 0,
        passthroughCalls: 0, imports: [], functions: [],
      }), query: () => Effect.succeed([]), supportedLanguages: Effect.succeed(["typescript"]),
    });
    // 关键：baseline 里**一个 test 条目都没有**（= 全部测试文件都还没入 baseline）
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: () => Effect.void, readIndex: () => Effect.succeed(null), writeIndex: () => Effect.void,
      writeFileMetrics: () => Effect.void, deleteFileMetrics: () => Effect.void, readFileMetrics: () => Effect.succeed(null),
      listAllFileMetrics: () => Effect.succeed([[subjectPath, {
        path: subjectPath, fileKind: "production" as const,
        branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0,
      }]]),
      clearFileMetrics: () => Effect.void, writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null), readAllHistory: () => Effect.succeed([]),
    });
    const LockTest = Layer.succeed(LockService, {
      acquire: () => Effect.succeed({ name: "governance-state-write", agentId: "test", acquiredAt: 0, lockId: "test-lock" }),
      release: () => Effect.void,
    });
    const report = await Effect.runPromise(testGovernance({
      providerIds: ["typescript-vitest"], policy: { rules: {} }, rules: [],
      discoveredTestFiles: [toAbsolute("test/basic.test.ts"), toAbsolute("test/component.test.ts")],
    }).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest))));
    expect(report.collection.coverage.unbaselinedTestFiles).toHaveLength(2);
    // D-G18：实时发现的两个文件都是候选且都被 provider 处理，只是没有用例体事实 ⇒
    // availability=available（不是"没评估"），value 如实地为空数组，不伪造 span。
    expect(report.collection.providerCoverage[0]).toMatchObject({
      candidateTestFiles: [toAbsolute("test/basic.test.ts"), toAbsolute("test/component.test.ts")],
      providerHandledTestFiles: [toAbsolute("test/basic.test.ts"), toAbsolute("test/component.test.ts")],
    });
    expect(report.collection.testCaseSpans).toEqual({ availability: "available", value: [] });
  });

  /**
   * D-G18 的主证据（2026-09-25 项目所有者批准）：provider 采集范围 = **实时发现**的测试文件。
   *
   * 改动前 `vue3-vitesse` 实测"可发现=3 / provider 处理=0"——未入 baseline 的测试文件
   * 产生不了任何 provider finding。本用例用真实 `typescript-vitest` provider 证明：
   *  - 未入 baseline 的 `new.test.ts` **能**产出 finding，并带来源标记 `unbaselined: true`；
   *  - 已入 baseline 的 `old.test.ts` 产出 finding 且**不带**该键（缺省即旧语义）；
   *  - 覆盖状态与候选数字改用实时口径（candidates 含未入 baseline 的文件）。
   */
  it("collects findings for unbaselined test files and marks only those findings", async () => {
    const baselineTestPath = toAbsolute("packages/core/__tests__/old.test.ts");
    const newTestPath = toAbsolute("packages/core/__tests__/new.test.ts");
    // 只识别 focused 用例所需的 member pattern；其余查询返回空。
    const ParserTest = Layer.succeed(ParserService, {
      parse: (path) => Effect.succeed({
        path, language: "typescript" as const, branchCount: 0, nestingDepth: 0, functionCount: 0,
        passthroughCalls: 0, imports: [], functions: [],
      }),
      query: (_path, pattern) => {
        if (!pattern.includes("@modifier")) return Effect.succeed([]);
        return Effect.succeed([{
          captures: [
            { name: "callee", text: "it", startLine: 1 },
            { name: "modifier", text: "only", startLine: 1 },
            { name: "name", text: "'focused'", startLine: 1 },
            { name: "body", text: "{ }", startLine: 1, endLine: 1, startIndex: 0, endIndex: 3 },
          ],
        }]);
      },
      supportedLanguages: Effect.succeed(["typescript"]),
    });
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: () => Effect.void, readIndex: () => Effect.succeed(null), writeIndex: () => Effect.void,
      writeFileMetrics: () => Effect.void, deleteFileMetrics: () => Effect.void, readFileMetrics: () => Effect.succeed(null),
      // canonical baseline 只含 old.test.ts：new.test.ts 尚未 scan。
      listAllFileMetrics: () => Effect.succeed([[baselineTestPath, {
        path: baselineTestPath, fileKind: "test" as const,
        branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0,
      }]]),
      clearFileMetrics: () => Effect.void, writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null), readAllHistory: () => Effect.succeed([]),
    });
    const LockTest = Layer.succeed(LockService, {
      acquire: () => Effect.succeed({ name: "governance-state-write", agentId: "test", acquiredAt: 0, lockId: "test-lock" }),
      release: () => Effect.void,
    });
    const report = await Effect.runPromise(testGovernance({
      providerIds: ["typescript-vitest"], policy: { rules: {} }, rules: [],
      discoveredTestFiles: [baselineTestPath, newTestPath],
    }).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest))));

    const findingsFor = (file: string) => report.decision.findings.filter((finding) => finding.file === file);
    // 未入 baseline：现在有事实（改动前这里恒为空），且带来源标记。
    // 该夹具是 `it.only`（无 expect）⇒ provider 同时报 focused_test 与 missing_assertion，两条都标记。
    expect(findingsFor(newTestPath)).toEqual([
      {
        ruleId: "vitest.focused-test", kind: "focused_test", file: newTestPath,
        testName: "focused", line: 1, evidence: ["it.only/test.only"], confidence: "confirmed",
        source: "typescript-vitest", unbaselined: true,
      },
      {
        ruleId: "vitest.missing-known-assertion", kind: "missing_assertion", file: newTestPath,
        testName: "focused", evidence: ["no recognised expect() call in test body"], confidence: "low",
        source: "typescript-vitest", unbaselined: true,
      },
    ]);
    // 已入 baseline：同样有事实，但**不带** unbaselined（缺省即旧语义，老消费者逐字段不变）。
    expect(findingsFor(baselineTestPath)).toEqual([
      {
        ruleId: "vitest.focused-test", kind: "focused_test", file: baselineTestPath,
        testName: "focused", line: 1, evidence: ["it.only/test.only"], confidence: "confirmed",
        source: "typescript-vitest",
      },
      {
        ruleId: "vitest.missing-known-assertion", kind: "missing_assertion", file: baselineTestPath,
        testName: "focused", evidence: ["no recognised expect() call in test body"], confidence: "low",
        source: "typescript-vitest",
      },
    ]);
    expect(report.decision.findings.filter((finding) => finding.unbaselined === true).map((finding) => finding.file))
      .toEqual([newTestPath, newTestPath]);
    // 覆盖与候选数字都是实时口径：candidates = 两个被发现的文件（不只 baseline 那个），
    // 顺序即采集顺序（discoverProjectTestFiles 结果已排序 ⇒ new 在 old 之前）。
    expect(report.collection.providerCoverage[0]).toMatchObject({
      status: "partial",
      reasons: ["test_files_missing_from_baseline"],
      candidateTestFiles: [newTestPath, baselineTestPath],
      unbaselinedTestFiles: [newTestPath],
      providerHandledTestFiles: [newTestPath, baselineTestPath],
      failedTestFiles: [],
    });
    // 未入 baseline 仍是事实边界：不必等于 clean，也不必阻断（只报告）。
    expect(report.collection.coverage.status).toBe("partial");
    expect(report.collection.coverage.unbaselinedTestFiles).toEqual([newTestPath]);
  });

  /**
   * D-G18 的**构造性保证**回归（2026-09-25）：未入 baseline 的 finding 进不了校准证据。
   *
   * 这条保证不是额外过滤出来的，而是两层事实相乘的结果：
   *  ① provider 采集范围 = 实时发现集合 ⇒ 未入 baseline 的文件也会被采集、并发 finding；
   *  ② 同一批文件的 `unbaselinedTestFiles` 非空 ⇒ `assessTestProviderCoverage` 把该 provider
   *     判为 `partial`（`test_files_missing_from_baseline`）；
   *  ③ 校准导出的前提是该 provider 覆盖为 `available`（`packages/cli/src/commands/evidence.ts`
   *     的 `scopedTestEvidence`：`coverage.status !== "available"` 直接拒绝导出，见
   *     `__tests__/unit/evidenceCommand.test.ts`）。
   *
   * 因此断言直指保证本身——"存在被该 provider 声明支持、且未入 baseline 的测试文件时，
   * 这个 provider 的覆盖**不可能**是 `available`"，而非复述实现细节。若将来有人把覆盖口径
   * 改回 baseline 驱动、或让 provider 在存在未对账文件时仍报 `available`，本用例必须失败。
   */
  it("keeps unbaselined findings out of calibration evidence by construction", async () => {
    const baselineTestPath = toAbsolute("packages/core/__tests__/old.test.ts");
    const newTestPath = toAbsolute("packages/core/__tests__/new.test.ts");
    // 第三个文件：未入 baseline，但当前 provider **不声明支持**（Go）⇒ 它既不是候选也不会
    // 产生 finding，正是"未入 baseline 本身不构成缺口"的边界（不能拿来当反例）。
    const unsupportedPath = toAbsolute("services/coordination/internal/evidence/sample_test.go");
    const ParserTest = Layer.succeed(ParserService, {
      parse: (path) => Effect.succeed({
        path, language: "typescript" as const, branchCount: 0, nestingDepth: 0, functionCount: 0,
        passthroughCalls: 0, imports: [], functions: [],
      }),
      query: (_path, pattern) => {
        if (!pattern.includes("@modifier")) return Effect.succeed([]);
        return Effect.succeed([{
          captures: [
            { name: "callee", text: "it", startLine: 1 },
            { name: "modifier", text: "only", startLine: 1 },
            { name: "name", text: "'focused'", startLine: 1 },
            { name: "body", text: "{ }", startLine: 1, endLine: 1, startIndex: 0, endIndex: 3 },
          ],
        }]);
      },
      supportedLanguages: Effect.succeed(["typescript"]),
    });
    const StorageTest = Layer.succeed(StorageService, {
      writeBaseline: () => Effect.void, readIndex: () => Effect.succeed(null), writeIndex: () => Effect.void,
      writeFileMetrics: () => Effect.void, deleteFileMetrics: () => Effect.void, readFileMetrics: () => Effect.succeed(null),
      listAllFileMetrics: () => Effect.succeed([[baselineTestPath, {
        path: baselineTestPath, fileKind: "test" as const,
        branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0,
      }]]),
      clearFileMetrics: () => Effect.void, writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null), readAllHistory: () => Effect.succeed([]),
    });
    const LockTest = Layer.succeed(LockService, {
      acquire: () => Effect.succeed({ name: "governance-state-write", agentId: "test", acquiredAt: 0, lockId: "test-lock" }),
      release: () => Effect.void,
    });
    const report = await Effect.runPromise(testGovernance({
      providerIds: ["typescript-vitest"], policy: { rules: {} }, rules: [],
      discoveredTestFiles: [baselineTestPath, newTestPath, unsupportedPath],
    }).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageTest, LockTest))));

    // 前置事实：确实存在带来源标记的 finding（否则下面的断言是空真结论）。
    const unbaselinedFindings = report.decision.findings.filter((finding) => finding.unbaselined === true);
    expect(unbaselinedFindings.length).toBeGreaterThan(0);
    expect(new Set(unbaselinedFindings.map((finding) => finding.source))).toEqual(new Set(["typescript-vitest"]));

    // 保证本身：任何**声明支持未入 baseline 文件**的 provider 都不可能报 `available`。
    const providersThatClaimUnbaselinedFiles = report.collection.providerCoverage
      .filter((coverage) => coverage.candidateTestFiles.some((path) => coverage.unbaselinedTestFiles.includes(path)));
    expect(providersThatClaimUnbaselinedFiles.length).toBeGreaterThan(0);
    expect(providersThatClaimUnbaselinedFiles.filter((coverage) => coverage.status === "available")).toEqual([]);
    expect(providersThatClaimUnbaselinedFiles.map((coverage) => [coverage.providerId, coverage.status, coverage.reasons]))
      .toEqual([["typescript-vitest", "partial", ["test_files_missing_from_baseline"]]]);

    // 与校准导出前提**同式**的判定：`scopedTestEvidence`（packages/cli/src/commands/evidence.ts）
    // 的第一步硬拒绝就是 `if (coverage.status !== "available") throw ...`，所以只要该 provider
    // 携带未入 baseline 的 finding，导出就必然停在"拒绝"一侧——不需要任何额外过滤。
    const exportPreconditionOf = (providerId: string) =>
      report.collection.providerCoverage.find((coverage) => coverage.providerId === providerId)?.status === "available";
    for (const finding of unbaselinedFindings) {
      expect(exportPreconditionOf(finding.source)).toBe(false);
    }

    // 边界对照：未被任何 provider 声明支持的文件既不在候选、也没有 finding，
    // 它**不算**这条保证的反例（未入 baseline 本身不是缺口，缺对账对象才是）。
    const vitestCoverage = report.collection.providerCoverage.find((coverage) => coverage.providerId === "typescript-vitest");
    expect(vitestCoverage?.candidateTestFiles).not.toContain(unsupportedPath);
    expect(unbaselinedFindings.map((finding) => finding.file)).not.toContain(unsupportedPath);
  });

  /**
   * §6（2026-09-27）：`shapes` 契约在 `test` 命令面的两条 failure/identity 语义。
   *
   * - 声明**不可用**（未接线类别）⇒ 必须作为错误上报并 BLOCK：既不能当"已声明"（判据没变），
   *   也不能当"未声明"（身份宣称了形状）——静默继续就是"身份变了、事实没变"。
   * - 形状身份与 baseline 不一致 ⇒ coverage 降级为 `partial`，原因码独立
   *   （`baseline_shapes_incompatible`，不与范围不兼容合并）。
   */
  it("fails closed on an unusable shapes declaration and reports a distinct shapes-identity reason", async () => {
    const testPath = toAbsolute("packages/core/__tests__/shapes.test.ts");
    const ParserTest = Layer.succeed(ParserService, {
      parse: (path) => Effect.succeed({
        path, language: "typescript" as const, branchCount: 0, nestingDepth: 0, functionCount: 0,
        passthroughCalls: 0, imports: [], functions: [],
      }), query: () => Effect.succeed([]), supportedLanguages: Effect.succeed(["typescript"]),
    });
    const index = (shapesFingerprint?: string) => ({
      version: "5.2",
      meta: {
        scanAt: "2026-01-01T00:00:00.000Z", nFiles: 1,
        analysisScope: { fingerprint: createAnalysisScope(readProjectLanguages(), []).fingerprint, complete: true },
        ...(shapesFingerprint === undefined ? {} : { shapesFingerprint }),
        snapshotSha256: "sha", metricContractVersion: METRIC_CONTRACT_VERSION,
      },
    });
    const StorageWith = (shapesFingerprint?: string) => Layer.succeed(StorageService, {
      writeBaseline: () => Effect.void, readIndex: () => Effect.succeed(index(shapesFingerprint) as never), writeIndex: () => Effect.void,
      writeFileMetrics: () => Effect.void, deleteFileMetrics: () => Effect.void, readFileMetrics: () => Effect.succeed(null),
      listAllFileMetrics: () => Effect.succeed([[testPath, {
        path: testPath, fileKind: "test" as const,
        branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0,
      }]]),
      clearFileMetrics: () => Effect.void, writeHistory: () => Effect.void, readHistoryEntry: () => Effect.succeed(null), readAllHistory: () => Effect.succeed([]),
    });
    const LockTest = Layer.succeed(LockService, {
      acquire: () => Effect.succeed({ name: "governance-state-write", agentId: "test", acquiredAt: 0, lockId: "test-lock" }),
      release: () => Effect.void,
    });
    await withTemporaryDirectory("governance-shapes", async (dir) => {
      const base = join(dir, ".openarch");
      mkdirSync(base, { recursive: true });
      const previous = process.env.OPENARCH_BASE_DIR;
      process.env.OPENARCH_BASE_DIR = base;
      try {
        const run = (shapesFingerprint?: string) => Effect.runPromise(testGovernance({
          providerIds: ["typescript-vitest"], policy: { rules: {} }, rules: [], discoveredTestFiles: [testPath],
        }).pipe(Effect.provide(Layer.mergeAll(ParserTest, StorageWith(shapesFingerprint), LockTest))));

        // 1) 未声明 + 旧 baseline（无字段）⇒ 零变化的对照：没有形状原因码。
        const compatible = await run(undefined);
        expect(compatible.decision.errors).toEqual([]);
        expect(compatible.collection.coverage.reasons).not.toContain("baseline_shapes_incompatible");

        // 2) 当前声明了 shapes、baseline 没有 ⇒ 独立原因码 + partial 降级。
        writeFileSync(join(base, "config.yml"), "shapes:\n  typescript:\n    weak_assertion_methods: [toBeTruthy]\n");
        const moved = await run(undefined);
        expect(moved.collection.coverage.reasons).toContain("baseline_shapes_incompatible");
        expect(moved.collection.coverage.status).toBe("partial");

        // 3) 声明不可用（未接线类别）⇒ 显式错误 + BLOCK，绝不静默当作"未声明"。
        writeFileSync(join(base, "config.yml"), "shapes:\n  typescript:\n    assertion_methods: [expect]\n");
        const invalid = await run(undefined);
        expect(invalid.decision.verdict).toBe("BLOCK");
        expect(invalid.decision.errors.join(" ")).toContain("shapes 声明不可用");
        expect(invalid.decision.errors.join(" ")).toContain("shapes.typescript.assertion_methods");
      } finally {
        if (previous === undefined) delete process.env.OPENARCH_BASE_DIR;
        else process.env.OPENARCH_BASE_DIR = previous;
      }
    });
  });
});
