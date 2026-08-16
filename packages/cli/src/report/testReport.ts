import { renderAlignedTable, renderFormulaLine } from "./table";
import { MACHINE_CONTRACT_VERSIONS, type TestFinding, type TestGovernanceCoverage, type TestGovernanceReport } from "@openarch/core";

export const renderTestCoverage = (coverage: TestGovernanceCoverage): readonly string[] => {
  const lines = [
    `- 覆盖状态: ${coverage.status.toUpperCase()}`,
    `- 覆盖范围: 当前可发现测试文件=${coverage.testFiles}, provider 成功处理=${coverage.providerHandledTestFiles.length}`,
  ];
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

const renderBloat = (report: TestGovernanceReport): readonly string[] => {
  if (!report.bloat) return [];
  const { bloat } = report;
  const rows = bloat.parts.map((part) => [
    part.name,
    part.value.toFixed(3),
    part.threshold.toFixed(3),
    part.weight.toFixed(2),
    part.contribution.toFixed(3),
  ]);
  const advice = bloat.parts
    .filter((part) => part.value > part.threshold)
    .map((part) => {
      const suggestion = part.name === "sizeDispersion"
        ? part.suggestion.replace("X", part.value.toFixed(1))
        : part.suggestion;
      return `  · ${part.name} — ${suggestion}`;
    });
  // 触发因子的文件级证据（与反模式/定义面信号的定位能力对齐）
  const evidenceLines = bloat.evidence.map((entry) =>
    `  → ${entry.file}: ${entry.detail}`,
  );
  return [
    renderFormulaLine("测试膨胀指标 TEST_BLOAT", "score = Σ wᵢ·min(1, vᵢ/Tᵢ)", bloat.score.toFixed(3), bloat.triggered ? "* 已触发" : "（正常范围）"),
    ...renderAlignedTable(
      [
        { header: "factor", align: "left" },
        { header: "vᵢ", align: "right" },
        { header: "Tᵢ", align: "right" },
        { header: "wᵢ", align: "right" },
        { header: "contribution", align: "right" },
      ],
      rows,
      { indent: "  ", rowPrefix: (index) => (bloat.parts[index]!.value > bloat.parts[index]!.threshold ? "* " : "  ") },
    ),
    ...(advice.length > 0 ? [`  治理建议（* = 触发项）:`, ...advice] : []),
    ...(evidenceLines.length > 0 ? [`  触发证据（文件级）:`, ...evidenceLines] : []),
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

const testFindingGuidance = (finding: Pick<TestFinding, "kind">): { readonly patternFamily: string; readonly suggestion: string } | undefined => {
  if (finding.kind !== "missing_assertion") return undefined;
  return {
    patternFamily: "test-illusion",
    suggestion: "确认测试是否有直接可识别的断言；若验证的是异常、回调或自定义断言，请补充 provider 事实或记录合法边界",
  };
};

const renderFinding = (finding: TestFinding): string => {
  const annotation = testFindingGuidance(finding);
  const family = annotation ? ` family=${annotation.patternFamily}` : "";
  return `  [${finding.confidence.toUpperCase()}] ${finding.kind}: ${finding.file}${finding.testName ? ` (${finding.testName})` : ""}${family}`;
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

/** test --json 的稳定机器契约（schema 版本化；只投影决策与边界事实，不做维护负担或质量评分）。 */
export interface TestGovernanceJsonContract {
  readonly schema: typeof MACHINE_CONTRACT_VERSIONS.testGovernanceJson;  readonly verdict: "PASS" | "WARN" | "BLOCK";
  readonly decision: {
    readonly verdict: "PASS" | "WARN" | "BLOCK";
    readonly findingCount: number;
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
    readonly testCaseSpans: { readonly availability: string; readonly reason?: string };
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
    readonly parts: readonly { readonly name: string; readonly value: number; readonly threshold: number; readonly weight: number; readonly contribution: number; readonly triggered: boolean }[];
  };
}

export const testGovernanceJsonValue = (report: TestGovernanceReport): TestGovernanceJsonContract => {
  const associations = report.collection.staticModuleAssociations;
  const testFiles = new Set(associations.map((entry) => entry.testFile)).size;
  const modules = new Set(associations.map((entry) => entry.association.targetPath)).size;
  const low = associations.filter((entry) => entry.association.confidence === "low").length;
  return {
    schema: MACHINE_CONTRACT_VERSIONS.testGovernanceJson,
    verdict: report.decision.verdict,
    decision: {
      verdict: report.decision.verdict,
      findingCount: report.decision.findings.length,
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
        parts: report.bloat.parts.map((part) => ({
          name: part.name,
          value: part.value,
          threshold: part.threshold,
          weight: part.weight,
          contribution: part.contribution,
          triggered: part.value > part.threshold,
        })),
      },
    } : {}),
  };
};

export const renderTestGovernanceReport = (report: TestGovernanceReport, args: readonly string[]): readonly string[] => {
  const verbose = args.includes("--verbose");
  return [
    "## 测试治理报告",
    ...renderTestCoverage(report.collection.coverage),
    ...renderSuggestedAdapters(report),
    `- 策略裁决: ${report.decision.verdict}（仅基于已收集的 finding）`,
    `- 测试文件: ${report.collection.testFiles}`,
    `- Provider: ${report.collection.providersRun.join(", ") || "无"}`,
    ...renderExecutions(report),
    ...renderProviderCoverage(report),
    ...renderProviderSummaries(report),
    `- Test-case spans: ${report.collection.testCaseSpans.availability.toUpperCase()}${report.collection.testCaseSpans.reason ? ` (${report.collection.testCaseSpans.reason})` : ""}`,
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
