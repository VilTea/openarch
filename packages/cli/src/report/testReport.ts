import { renderAlignedTable, renderFormulaLine } from "./table";
import { MACHINE_CONTRACT_VERSIONS, type TestFinding, type TestGovernanceCoverage, type TestGovernanceReport } from "@openarch/core";

/**
 * 覆盖范围两行。
 *
 * D-G8（2026-09-25 跨语言核实）：`可发现测试文件` 来自**实时分类**（`discoverProjectTestFiles`），
 * 而 `provider 成功处理` 来自**baseline 的 test 条目**（provider 只在 baseline 总体上采集）。
 * 两者是不同总体，却并排打印且无来源标注 ⇒ 读者会当成同一集合的分子/分母。
 *
 * D-G18（2026-09-25 项目所有者批准）后**两个数字已同口径**：provider 采集范围也是实时发现
 * 集合，所以该行不再声称"provider 只采集 baseline 中已存在的测试文件"（那句话已不成立），
 * `provider 成功处理` 的来源标注同步改为"实时发现"。
 *
 * 差异仍可能出现且仍必须解释，但原因已经不同：未识别（无 provider 声明支持）、
 * 采集失败，或该 provider 只声明支持其中的一部分后缀。诚实说法是"未能处理"，
 * 而不是把差异一律归因于 baseline。
 */
export const renderTestCoverage = (coverage: TestGovernanceCoverage): readonly string[] => {
  const handled = coverage.providerHandledTestFiles.length;
  const lines = [
    `- 覆盖状态: ${coverage.status.toUpperCase()}`,
    `- 覆盖范围: 可发现测试文件（实时分类）=${coverage.testFiles}, provider 成功处理（实时发现，按 provider.supports 过滤）=${handled}`,
  ];
  if (coverage.testFiles !== handled) {
    lines.push(`- 总体差异: ${coverage.testFiles} 个实时分类中 ${handled} 个被当前启用 provider 成功处理；未处理者见下方"未由当前启用 provider 识别/采集失败"清单。未入 baseline 不再等于没有 provider 事实（D-G18），但仍需 scan 才能对账`);
  }
  if (coverage.reasons.length > 0) lines.push(`- 覆盖限制: ${coverage.reasons.join(", ")}`);
  return lines;
};

const renderSuggestedAdapters = (report: TestGovernanceReport): readonly string[] => {
  const suggestion = report.collection.suggestedAdapters;
  if (!suggestion) return [];
  const providers = suggestion.providers.join(", ") || "无";
  const runners = suggestion.runners.join(", ") || "无";
  return [`- 适配器建议（基于检测语言，请确认实际框架后写入 config.yml 的 test_governance）: providers=[${providers}] runners=[${runners}]`];
};

const renderProviderSummaries = (report: TestGovernanceReport): readonly string[] => report.collection.providerSummaries.map((summary) => {
  const p95 = summary.p95
    ? `LOC=${summary.p95.loc.toFixed(1)}, assertion=${summary.p95.assertionCount.toFixed(1)}, mock=${summary.p95.mockCount.toFixed(1)}, controlFlow=${summary.p95.testBodyControlFlow?.toFixed(1) ?? "UNAVAILABLE"}`
    : "UNAVAILABLE（未识别到测试用例）";
  return `  [${summary.providerId}] files=${summary.testFiles}, cases=${summary.testCases}, P95: ${p95}`;
});

const renderProviderCoverage = (report: TestGovernanceReport): readonly string[] => report.collection.providerCoverage.map((coverage) =>
  `  [${coverage.providerId}] ${coverage.status.toUpperCase()} candidates=${coverage.candidateTestFiles.length}, handled=${coverage.providerHandledTestFiles.length}, missingBaseline=${coverage.unbaselinedTestFiles.length}, failed=${coverage.failedTestFiles.length}`,
);

const renderExecutions = (report: TestGovernanceReport): readonly string[] => report.execution.executions.map(({ providerId, execution }) =>
  `  [${providerId}] ${execution.passed ? "PASS" : "FAIL"} ${execution.command}${execution.detail ? `: ${execution.detail}` : ""}`,
);

const renderAssociations = (report: TestGovernanceReport, verbose: boolean): readonly string[] => {
  if (report.collection.staticModuleAssociations.length === 0) return [];
  const testFiles = new Set(report.collection.staticModuleAssociations.map((entry) => entry.testFile)).size;
  const modules = new Set(report.collection.staticModuleAssociations.map((entry) => entry.association.targetPath)).size;
  const low = report.collection.staticModuleAssociations.filter((entry) => entry.association.confidence === "low").length;
  const lines = [`- S2 静态关联: testFiles=${testFiles}, modules=${modules}, edges=${report.collection.staticModuleAssociations.length}, low=${low}, medium=${report.collection.staticModuleAssociations.length - low}`];
  if (verbose) lines.push(...report.collection.staticModuleAssociations.map((entry) => {
    const detail = entry.association.confidence === "medium"
      ? ` (${entry.association.testName}: ${entry.association.symbol})` : ` (${entry.association.source})`;
    return `  [${entry.association.confidence.toUpperCase()}] ${entry.testFile} -> ${entry.association.targetPath}${detail}`;
  }));
  return lines;
};

const renderFileList = (title: string, marker: string, files: readonly string[], verbose: boolean): readonly string[] => {
  if (files.length === 0) return [];
  return [`- ${title}: ${files.length}`, ...(verbose ? files.map((file) => `  [${marker}] ${file}`) : [])];
};

/** 不可测因子的占位符：语言中立字面量（与 formatObservedP95 的 UNAVAILABLE 同一纪律）——
 *  绝不把不可测渲染成 0.000。 */
const UNAVAILABLE = "UNAVAILABLE";

const renderBloat = (report: TestGovernanceReport): readonly string[] => {
  if (!report.bloat) return [];
  const { bloat } = report;
  const isTriggeredPart = (part: typeof bloat.parts[number]): boolean => part.availability === "AVAILABLE" && part.value !== undefined && part.value > part.threshold;
  const rows = bloat.parts.map((part) => [
    part.name,
    part.value === undefined ? UNAVAILABLE : part.value.toFixed(3),
    part.threshold.toFixed(3),
    part.weight.toFixed(2),
    part.availability === "AVAILABLE" ? part.contribution.toFixed(3) : UNAVAILABLE,
  ]);
  const advice = bloat.parts
    .filter(isTriggeredPart)
    .map((part) => {
      const suggestion = part.name === "sizeDispersion"
        ? part.suggestion.replace("X", (part.value ?? 0).toFixed(1))
        : part.suggestion;
      return `  · ${part.name} — ${suggestion}`;
    });
  const unavailable = bloat.parts
    .filter((part) => part.availability !== "AVAILABLE")
    .map((part) => `  · ${part.name} — ${part.reason ?? UNAVAILABLE}`);
  // 触发因子的文件级证据（与反模式/定义面信号的定位能力对齐）：块级行范围 + 样本文本
  const evidenceLines = (bloat.evidence ?? []).map((entry) =>
    `  → ${entry.file} L${entry.startLine}-${entry.endLine}: ${entry.detail}`,
  );
  return [
    renderFormulaLine("测试膨胀指标 TEST_BLOAT", "score = Σ wᵢ·min(1, vᵢ/Tᵢ) / Σ wᵢ(可用)", bloat.score.toFixed(3), bloat.triggered ? "* 已触发" : "（正常范围）"),
    // 弱断言名单的来源披露（§6/Q1）：报告必须说明用的是"项目声明"还是"内置默认"，
    // 否则"哪些调用算弱断言"这件事在报告里没有入口。阈值不随形状走（§6/Q5），故此节只披露来源。
    ...(bloat.weakAssertionShapesSource
      ? [`  弱断言名单: ${bloat.weakAssertionShapesSource === "project" ? "项目声明（shapes.weak_assertion_methods，覆盖内置）" : "内置默认（本项目未声明被测语言的 shapes）"}（阈值不随形状走，实际取值见下表 Tᵢ）`]
      : []),
    ...renderAlignedTable(
      [
        { header: "factor", align: "left" },
        { header: "vᵢ", align: "right" },
        { header: "Tᵢ", align: "right" },
        { header: "wᵢ", align: "right" },
        { header: "contribution", align: "right" },
      ],
      rows,
      { indent: "  ", rowPrefix: (index) => (isTriggeredPart(bloat.parts[index]!) ? "* " : "  ") },
    ),
    ...(advice.length > 0 ? [`  治理建议（* = 触发项）:`, ...advice] : []),
    // DRY/DAMP 分界（校准 2026-09-25）：以 provider 确认的**用例体范围**为界——
    // 用例体内（含 arrange 与断言）不计分，只有用例体之外的装配样板才计分。
    ...(bloat.similarityBuckets
      ? [
        `  DRY/DAMP 分界: 装配(用例体外) ${bloat.similarityBuckets.assemblyRatio.toFixed(3)} + 未分类 ${bloat.similarityBuckets.unclassifiedRatio.toFixed(3)} = codeSimilarityRatio ${bloat.codeSimilarityRatio === undefined ? UNAVAILABLE : bloat.codeSimilarityRatio.toFixed(3)}；用例体内 ${bloat.similarityBuckets.caseBodyRatio.toFixed(3)} + 断言语义重复 ${bloat.similarityBuckets.assertionRatio.toFixed(3)}（DAMP 侧，不计分，不该为它抽 helper）`,
        ...(bloat.similarityBuckets.caseSpansAvailability !== "available" && bloat.similarityBuckets.caseSpansAvailability !== "not_requested"
          ? [`  用例体证据: ${bloat.similarityBuckets.caseSpansAvailability.toUpperCase()}——未识别出用例的文件不启用体界判据，其重复按未分类计分，属事实边界`]
          : []),
        ...(bloat.similarityBuckets.filesWithoutCaseSpans > 0
          ? [`  未识别出用例的文件: ${bloat.similarityBuckets.filesWithoutCaseSpans} 个——体界判据不适用，其调用块按未分类计分，属事实边界`]
          : []),
        ...(bloat.similarityBuckets.filesWithoutBlockEvidence > 0
          ? [`  块语义证据缺失: ${bloat.similarityBuckets.filesWithoutBlockEvidence} 个文件（Go/Rust 等无对应语法）——其重复按总量计分，属事实边界`]
          : []),
      ]
      : []),
    ...(unavailable.length > 0 ? [`  不可测因子（UNAVAILABLE，不计入归一化分母）:`, ...unavailable] : []),
    ...(evidenceLines.length > 0 ? [`  触发证据（文件级，Top-3）:`, ...evidenceLines] : []),
  ];
};

const renderScriptPruning = (report: TestGovernanceReport, verbose: boolean): readonly string[] => {
  if (report.scripts.scriptPruning.length === 0) return [];
  const lines = [`- 项目脚本剪枝: ${report.scripts.scriptPruning.length} 条规则`];
  if (verbose) lines.push(...report.scripts.scriptPruning.map((entry) =>
    `  [PRUNING] ${entry.rule}: ${entry.inputFiles} -> ${entry.targetFiles} targets -> ${entry.candidateFiles} candidates -> ${entry.records} records`,
  ));
  return lines;
};

/**
 * kind → 调查建议（**唯一映射点**）。
 *
 * D-G6 补充（2026-09-25）：`empty_test_body` 与 `missing_assertion` 是两种不同事实，
 * 建议也必须是两条。此前只有 `missing_assertion` 有建议，空体 finding 会出现在
 * `Review finding: N (empty_test_body=…)` 里却**没有任何调查路线**——违反"所有 signal
 * 必须响应"：拿到信号的人不知道下一步该做什么。
 */
const testFindingGuidance = (finding: Pick<TestFinding, "kind">): { readonly patternFamily: string; readonly suggestion: string } | undefined => {
  if (finding.kind === "missing_assertion") return {
    patternFamily: "test-illusion",
    suggestion: "确认测试是否有直接可识别的断言；若验证的是异常、回调或自定义断言，请补充 provider 事实或记录合法边界",
  };
  if (finding.kind === "empty_test_body") return {
    patternFamily: "empty-case-body",
    suggestion: "空体用例既不断言也不会失败：先确认它是**被测夹具**（外层元测试的素材，如嵌套类里的空 @Test）还是**漏写断言**；前者记录为合法边界，后者补断言。若整类都是夹具，用 test_governance.exemptions 按文件豁免而不是逐条忽略",
  };
  return undefined;
};

const renderFinding = (finding: TestFinding): string => {
  const annotation = testFindingGuidance(finding);
  const family = annotation ? ` family=${annotation.patternFamily}` : "";
  const location = finding.line === undefined ? "" : ` L${finding.line}`;
  return `  [${finding.confidence.toUpperCase()}] ${finding.kind}: ${finding.file}${location}${finding.testName ? ` (${finding.testName})` : ""}${family}`;
};

const renderTestReviewFindings = (report: TestGovernanceReport, verbose: boolean): readonly string[] => {
  const triggered = new Set(report.decision.triggered.map(({ finding }) => finding));
  const exempted = new Set(report.decision.exempted);
  const findings = report.decision.findings.filter((finding) => !triggered.has(finding) && !exempted.has(finding));
  if (findings.length === 0) return [];
  const byKind = new Map<string, number>();
  const guidance = new Map<string, string>();
  for (const finding of findings) {
    byKind.set(finding.kind, (byKind.get(finding.kind) ?? 0) + 1);
    const annotation = testFindingGuidance(finding);
    if (annotation) guidance.set(annotation.patternFamily, annotation.suggestion);
  }
  const summary = [...byKind.entries()].map(([kind, count]) => `${kind}=${count}`).join(", ");
  return [
    `- Review finding: ${findings.length} (${summary})`,
    ...[...guidance.entries()].map(([family, suggestion]) => `- 调查建议 (${family}): ${suggestion}`),
    ...(verbose ? findings.map(renderFinding) : []),
  ];
};

/** test --json 的稳定机器契约（schema 版本化；只投影决策与边界事实，不做维护负担或质量评分）。
 *  契约版本决策（缺陷 1）：新增字段是非破坏性追加，按 contractCatalog.ts 的契约纪律
 *  （"新增非破坏字段可在同 version 内追加"）保持 `test-governance-json-v1`——
 *  bump 到 v2 会要求 DSH 插件 fail-closed 读取面、state schema 与 zh/en 帮助文本同步，
 *  而帮助文本在 packages/cli/src/i18n.ts（本次改动范围外）。
 *  顶层直接字段纪律：report-surface-audit 预算 7；当前顶层已有 7 个
 *  （schema/verdict/decision/collection/execution/scripts/bloat），所以逐条 finding
 *  投影进 `decision`（与 findingCount/triggered 同一裁决面），不新增顶层字段。 */
export interface TestGovernanceJsonContract {
  readonly schema: typeof MACHINE_CONTRACT_VERSIONS.testGovernanceJson;  readonly verdict: "PASS" | "WARN" | "BLOCK";
  readonly decision: {
    readonly verdict: "PASS" | "WARN" | "BLOCK";
    readonly findingCount: number;
    /** 全部 finding（triggered、仅 review、被豁免都在内）——观察面，不参与 verdict/gate/exit code。
     *  缺陷 1 之前只有聚合计数，agent 无法定位受影响用例。 */
    readonly findings: readonly {
      readonly file: string;
      /** 用例名（provider 未给出时缺省）。 */
      readonly case?: string;
      readonly kind: string;
      /** provider 提供的用例行号；未提供时缺省，不伪造。 */
      readonly line?: number;
      readonly evidence: readonly string[];
      readonly confidence: string;
      /** D-G18：该 finding 来自未入 canonical baseline 的测试文件（缺省即可对账的旧语义）。
       *  非破坏追加——不设该键时输出逐字节与改动前一致。 */
      readonly unbaselined?: true;
    }[];
    readonly triggered: readonly { readonly level: "block" | "warn"; readonly kind: string; readonly file: string; readonly testName?: string }[];
    readonly exemptedCount: number;
    readonly errors: readonly string[];
  };
  readonly collection: {
    readonly coverage: {
      readonly status: string;
      readonly reasons: readonly string[];
      readonly testFiles: number;
      readonly unbaselinedTestFiles: number;
      readonly providerHandledTestFiles: number;
      readonly unrecognizedTestFiles: number;
      readonly failedTestFiles: number;
    };
    readonly providers: readonly {
      readonly providerId: string;
      readonly status: string;
      readonly reasons: readonly string[];
      readonly candidates: number;
      readonly handled: number;
      readonly missingBaseline: number;
      readonly failed: number;
    }[];
    readonly testFiles: number;
    readonly providersRun: readonly string[];
    readonly summaries: readonly {
      readonly providerId: string;
      readonly testFiles: number;
      readonly testCases: number;
      readonly p95?: {
        readonly loc: number;
        readonly assertionCount: number;
        readonly mockCount: number;
        readonly testBodyControlFlow?: number;
      };
    }[];
    /** D-G3：`spanCount`/`value` 仅在 `--spans` 时出现（非破坏性追加字段，仍属 v1）。
     *  `availability !== "available"` 时只给 `spanCount: 0`，绝不伪造明细。 */
    readonly testCaseSpans: {
      readonly availability: string;
      readonly reason?: string;
      readonly spanCount?: number;
      readonly value?: readonly {
        readonly file: string;
        readonly providerId: string;
        readonly name: string;
        readonly startLine: number;
        readonly endLine: number;
        readonly statuses: readonly string[];
      }[];
    };
    readonly unrecognizedTestFiles: readonly string[];
    readonly suggestedAdapters?: { readonly providers: readonly string[]; readonly runners: readonly string[] };
    readonly staticModuleAssociations: { readonly testFiles: number; readonly modules: number; readonly edges: number; readonly low: number; readonly medium: number };
    readonly associationUnavailableTestFiles: number;
  };
  readonly execution: {
    readonly runnersRun: readonly string[];
    readonly executions: readonly { readonly providerId: string; readonly passed: boolean; readonly command: string; readonly detail?: string }[];
  };
  readonly scripts: {
    readonly unavailable: readonly string[];
    readonly pruning: readonly { readonly rule: string; readonly inputFiles: number; readonly targetFiles: number; readonly candidateFiles: number; readonly records: number }[];
  };
  readonly bloat?: {
    readonly score: number;
    readonly triggered: boolean;
    /** 归一化分母：可用因子权重之和（全部可用 = 1.0）。 */
    readonly availableWeight: number;
    /** UNAVAILABLE 因子缺省 `value`/`contribution`（绝不把不可测序列化成 0），
     *  以 `availability` + `reason` 表达事实边界（language-parser-extension.md §3）。 */
    readonly parts: readonly {
      readonly name: string;
      readonly value?: number;
      readonly threshold: number;
      readonly weight: number;
      readonly contribution?: number;
      readonly availability: string;
      readonly reason?: string;
      readonly triggered: boolean;
    }[];
    /** 触发因子的文件级证据（含块级 startLine/endLine 与样本文本）。 */
    readonly evidence: readonly {
      readonly factor: string;
      readonly file: string;
      readonly value: number;
      readonly detail: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly sample: string;
    }[];
    /** DRY/DAMP 分界（report-only 观察值）：用例体内与断言重复不计分，但必须可见。 */
    readonly similarityBuckets: {
      readonly assemblyRatio: number;
      readonly unclassifiedRatio: number;
      readonly assertionRatio: number;
      readonly caseBodyRatio: number;
      readonly filesWithoutBlockEvidence: number;
      readonly filesWithoutCaseSpans: number;
      readonly caseSpansAvailability: string;
    };
    /**
     * 弱断言判据生效的名单来源（§6/Q1 披露；**非破坏追加的可选字段**，不改 schema 版本）：
     * `project` = 项目 `shapes` 声明覆盖了内置名单；`builtin` = 内置默认。
     * `builtin` 只说明"**被测语言**没有项目声明"（项目可能声明了别的语言）——不得读成"项目未声明 shapes"。
     * 缺省 = 本次没有可测的语言绑定测试文件（不写 `builtin` 冒充"已确认用内置"）。
     */
    readonly weakAssertionShapesSource?: "project" | "builtin";
  };
}

/**
 * 机器契约的可选投影开关（**合同面**，不是渲染偏好）。
 *
 * D-G3（2026-09-25，项目所有者批准）：provider 产出的 test-case spans 此前完全不进契约
 * （只有 `availability`），消费方无法复核 DRY/DAMP 分界所用的"用例体"事实。
 * 明细按需取（`--spans`）而不是默认输出：1350 个用例的 spans 会显著放大契约体积，
 * 而绝大多数消费方只需要 availability 与计数。
 */
export interface TestGovernanceJsonOptions {
  /** 是否投影 `collection.testCaseSpans.value` 明细（默认 false）。 */
  readonly spans?: boolean;
}

export const testGovernanceJsonValue = (
  report: TestGovernanceReport,
  options: TestGovernanceJsonOptions = {},
): TestGovernanceJsonContract => {
  const associations = report.collection.staticModuleAssociations;
  const testFiles = new Set(associations.map((entry) => entry.testFile)).size;
  const modules = new Set(associations.map((entry) => entry.association.targetPath)).size;
  const low = associations.filter((entry) => entry.association.confidence === "low").length;
  const spans = report.collection.testCaseSpans;
  return {
    schema: MACHINE_CONTRACT_VERSIONS.testGovernanceJson,
    verdict: report.decision.verdict,
    decision: {
      verdict: report.decision.verdict,
      findingCount: report.decision.findings.length,
      findings: report.decision.findings.map((finding) => ({
        file: finding.file,
        ...(finding.testName ? { case: finding.testName } : {}),
        kind: finding.kind,
        ...(finding.line === undefined ? {} : { line: finding.line }),
        evidence: finding.evidence,
        confidence: finding.confidence,
        ...(finding.unbaselined ? { unbaselined: true as const } : {}),
      })),
      triggered: report.decision.triggered.map(({ level, finding }) => ({
        level,
        kind: finding.kind,
        file: finding.file,
        ...(finding.testName ? { testName: finding.testName } : {}),
      })),
      exemptedCount: report.decision.exempted.length,
      errors: report.decision.errors,
    },
    collection: {
      coverage: {
        status: report.collection.coverage.status,
        reasons: report.collection.coverage.reasons,
        testFiles: report.collection.coverage.testFiles,
        unbaselinedTestFiles: report.collection.coverage.unbaselinedTestFiles.length,
        providerHandledTestFiles: report.collection.coverage.providerHandledTestFiles.length,
        unrecognizedTestFiles: report.collection.coverage.unrecognizedTestFiles.length,
        failedTestFiles: report.collection.coverage.failedTestFiles.length,
      },
      providers: report.collection.providerCoverage.map((coverage) => ({
        providerId: coverage.providerId,
        status: coverage.status,
        reasons: coverage.reasons,
        candidates: coverage.candidateTestFiles.length,
        handled: coverage.providerHandledTestFiles.length,
        missingBaseline: coverage.unbaselinedTestFiles.length,
        failed: coverage.failedTestFiles.length,
      })),
      testFiles: report.collection.testFiles,
      providersRun: report.collection.providersRun,
      summaries: report.collection.providerSummaries,
      testCaseSpans: {
        availability: report.collection.testCaseSpans.availability,
        ...(report.collection.testCaseSpans.reason ? { reason: report.collection.testCaseSpans.reason } : {}),
        ...(options.spans === true ? { spanCount: spans.availability === "available" ? (spans.value?.length ?? 0) : 0 } : {}),
        ...(options.spans === true && spans.availability === "available" ? { value: spans.value ?? [] } : {}),
      },
      unrecognizedTestFiles: report.collection.unrecognizedTestFiles,
      ...(report.collection.suggestedAdapters ? { suggestedAdapters: report.collection.suggestedAdapters } : {}),
      staticModuleAssociations: { testFiles, modules, edges: associations.length, low, medium: associations.length - low },
      associationUnavailableTestFiles: report.collection.associationUnavailableTestFiles.length,
    },
    execution: {
      runnersRun: report.execution.runnersRun,
      executions: report.execution.executions.map(({ providerId, execution }) => ({
        providerId,
        passed: execution.passed,
        command: execution.command,
        ...(execution.detail ? { detail: execution.detail } : {}),
      })),
    },
    scripts: {
      unavailable: report.scripts.scriptUnavailable,
      pruning: report.scripts.scriptPruning,
    },
    ...(report.bloat ? {
      bloat: {
        score: report.bloat.score,
        triggered: report.bloat.triggered,
        availableWeight: report.bloat.availableWeight,
        parts: report.bloat.parts.map((part) => ({
          name: part.name,
          ...(part.value === undefined ? {} : { value: part.value }),
          threshold: part.threshold,
          weight: part.weight,
          ...(part.availability === "AVAILABLE" ? { contribution: part.contribution } : {}),
          availability: part.availability,
          ...(part.reason === undefined ? {} : { reason: part.reason }),
          triggered: part.availability === "AVAILABLE" && part.value !== undefined && part.value > part.threshold,
        })),
        evidence: (report.bloat.evidence ?? []).map((entry) => ({
          factor: entry.factor,
          file: entry.file,
          value: entry.value,
          detail: entry.detail,
          startLine: entry.startLine,
          endLine: entry.endLine,
          sample: entry.sample,
        })),
        similarityBuckets: report.bloat.similarityBuckets,
        // §6/Q1 披露：可选追加字段（消费方 fail-closed；schema 版本不 bump）。
        ...(report.bloat.weakAssertionShapesSource ? { weakAssertionShapesSource: report.bloat.weakAssertionShapesSource } : {}),
      },
    } : {}),
  };
};

/**
 * 裁决依据必须与事实一致（2026-09-25 实地核实）。
 *
 * 缺陷 1（G2）：原文一律渲染"仅基于已收集的 finding"，但当 `decision.errors` 非空时
 * （例如 config.yml 写了未知 provider id）verdict 是 `errors.length > 0 ? "BLOCK"`，
 * **与 finding 无关**。真实观测：适配器建议被照抄后报告同时打印
 * `适配器建议: providers=[junit]` 与 `策略裁决: BLOCK（仅基于已收集的 finding）`，
 * 而真相是 `未知测试 provider: junit` ⇒ 报告在"裁决依据"上说了假话。
 *
 * 缺陷 2（D-G4，项目所有者批准）：覆盖状态非 `available` 时 verdict 仍是 `PASS`——
 * 这正是宪法警告的 `PASS ≠ clean` 陷阱。免责必须落在**裁决行本身**，而不是指望读者
 * 把上一行"覆盖状态: UNAVAILABLE"与本行连起来看。措辞按状态区分，不谎称已评估。
 */
const renderVerdictBasis = (errorCount: number, coverage: TestGovernanceCoverage, verdict: string): string => {
  if (errorCount > 0) return `（BLOCK 来自 ${errorCount} 项治理错误，见下；仅基于已收集的 finding）`;
  if (coverage.status === "available") return "（仅基于已收集的 finding）";
  const limit = coverage.reasons.length > 0 ? coverage.reasons.join(", ") : coverage.status;
  const disclaimer = verdict === "PASS" ? "；PASS 不代表 clean" : "";
  return `（未评估全部测试：${limit}；仅基于已收集的 finding${disclaimer}）`;
};

/** D-G3：`--spans` 时列出用例体界明细（供人工复核 DAMP/DRY 分界所用的范围）。 */
const renderTestCaseSpans = (report: TestGovernanceReport, withSpans: boolean): readonly string[] => {
  const spans = report.collection.testCaseSpans;
  if (!withSpans || spans.availability !== "available") return [];
  const value = spans.value ?? [];
  return [
    `- Test-case spans 明细: ${value.length}`,
    ...value.map((span) => `  [SPAN] ${span.file}:${span.startLine}-${span.endLine} (${span.name})${span.statuses.length > 0 ? ` statuses=${span.statuses.join(",")}` : ""}`),
  ];
};

export const renderTestGovernanceReport = (report: TestGovernanceReport, args: readonly string[]): readonly string[] => {
  const verbose = args.includes("--verbose");
  return [
    "## 测试治理报告",
    ...renderTestCoverage(report.collection.coverage),
    ...renderSuggestedAdapters(report),
    `- 策略裁决: ${report.decision.verdict}${renderVerdictBasis(report.decision.errors.length, report.collection.coverage, report.decision.verdict)}`,
    `- 测试文件: ${report.collection.testFiles}`,
    `- Provider: ${report.collection.providersRun.join(", ") || "无"}`,
    ...renderExecutions(report),
    ...renderProviderCoverage(report),
    ...renderProviderSummaries(report),
    `- Test-case spans: ${report.collection.testCaseSpans.availability.toUpperCase()}${report.collection.testCaseSpans.reason ? ` (${report.collection.testCaseSpans.reason})` : ""}`,
    ...renderTestCaseSpans(report, args.includes("--spans")),
    ...renderScriptPruning(report, verbose),
    ...renderBloat(report),
    ...renderTestReviewFindings(report, verbose),
    ...renderAssociations(report, verbose),
    ...renderFileList("未纳入 baseline（请先运行 scan）", "MISSING_BASELINE", report.collection.coverage.unbaselinedTestFiles, verbose),
    ...renderFileList("S2 静态模块关联 UNAVAILABLE", "UNAVAILABLE", report.collection.associationUnavailableTestFiles, verbose),
    ...renderFileList("未由当前启用 provider 识别", "UNRECOGNIZED", report.collection.unrecognizedTestFiles, true),
    ...renderFileList("provider 采集失败", "FAILED", report.collection.coverage.failedTestFiles, verbose),
    ...report.decision.triggered.map((trigger) => `  [${trigger.level.toUpperCase()}] ${trigger.finding.kind}: ${trigger.finding.file}${trigger.finding.testName ? ` (${trigger.finding.testName})` : ""}`),
    ...report.decision.errors.map((error) => `  [CONFIG ERROR] ${error}`),
  ];
};
