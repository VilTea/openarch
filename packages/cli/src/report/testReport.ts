import { renderAlignedTable, renderFormulaLine } from "./table";
import type { TestFinding, TestGovernanceCoverage, TestGovernanceReport } from "@openarch/core";

export const renderTestCoverage = (coverage: TestGovernanceCoverage): readonly string[] => {
  const lines = [
    `- 覆盖状态: ${coverage.status.toUpperCase()}`,
    `- 覆盖范围: 当前可发现测试文件=${coverage.testFiles}, provider 成功处理=${coverage.providerHandledTestFiles.length}`,
  ];
  if (coverage.reasons.length > 0) lines.push(`- 覆盖限制: ${coverage.reasons.join(", ")}`);
  return lines;
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

export const renderTestGovernanceReport = (report: TestGovernanceReport, args: readonly string[]): readonly string[] => {
  const verbose = args.includes("--verbose");
  return [
    "## 测试治理报告",
    ...renderTestCoverage(report.collection.coverage),
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
