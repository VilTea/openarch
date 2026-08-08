import type { ChangeSurfaceContribution, DiffReport, ImpactPlanAction, MRChangeScope, MRLocalMetric, SymbolConsumerEvidence, SymbolScopeAdmissionRequirementId, SymbolUseReport } from "@openarch/core";

type ChangeSurfaceEntry = NonNullable<DiffReport["evidence"]["changeSurfaces"]>["surfaces"][number];
import { type Locale, message } from "../i18n";
import { renderAlignedTable } from "./table";

const signed = (value: number, digits = 2): string => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;

const metricLabel = (locale: Locale, metric: MRLocalMetric): string => message(locale, `diff.metric.${metric}`);
const scopeLabel = (locale: Locale, scope: MRChangeScope): string => message(locale, `diff.scope.${scope}`);

const renderLocalChanges = (locale: Locale, diagnosis: DiffReport["evidence"]["mrDetail"][number]): string => {
  const changes = (Object.entries(diagnosis.localBurden.metrics) as Array<[MRLocalMetric, { delta: number | null; normalizedDelta: number | null }]>)
    .filter(([, value]) => value.delta !== null && value.delta !== 0)
    .map(([metric, value]) => message(locale, "diff.metricDelta", { metric: metricLabel(locale, metric), delta: signed(value.delta!, 1), normalized: value.normalizedDelta === null ? "" : message(locale, "diff.normalizedDelta", { delta: signed(value.normalizedDelta) }) }));
  return changes.length > 0 ? changes.join(locale === "zh" ? "，" : ", ") : message(locale, "diff.noLocalChange");
};

const renderMRDetail = (locale: Locale, diagnosis: DiffReport["evidence"]["mrDetail"][number]): string => {
  const prefix = message(locale, "diff.mrPrefix", { file: diagnosis.file, scope: scopeLabel(locale, diagnosis.scope), source: diagnosis.beforeSource === "baseline" ? message(locale, "diff.sealedBaseline") : "" });
  if (diagnosis.beforeSource === "introduced") return `${prefix}${message(locale, "diff.introducedBefore")}`;
  if (diagnosis.beforeSource === "unavailable") return `${prefix}${message(locale, "diff.unavailableBefore")}`;
  return `${prefix}${message(locale, "diff.mrComparable", { changes: renderLocalChanges(locale, diagnosis), deterioration: diagnosis.localBurden.deterioration.toFixed(2), improvement: diagnosis.localBurden.improvement.toFixed(2), exposure: diagnosis.exposure.delta === null ? message(locale, "diff.exposureUnavailable") : signed(diagnosis.exposure.delta, 3) })}`;
};

const renderSummary = (locale: Locale, report: DiffReport): string => {
  if (report.summary.dMR !== 0) return message(locale, "diff.summaryDeterioration", { value: report.summary.dMR.toFixed(2) });
  if (report.evidence.mrDetail.some((detail) => detail.beforeSource === "introduced" || detail.beforeSource === "unavailable")) return message(locale, "diff.summaryBeforeUnavailable");
  return message(locale, "diff.summaryClean");
};

const renderAction = (locale: Locale, action: ImpactPlanAction): string => {
  switch (action.kind) {
    case "verify_direct_consumers": return message(locale, "diff.actionConsumers", { consumers: action.consumers.join(", ") });
    case "verify_public_contract": return message(locale, "diff.actionPublicContract");
    case "verify_dependency_boundary": return message(locale, "diff.actionDependencyBoundary");
    case "run_affected_quality": return message(locale, "diff.actionQuality");
  }
};

const renderPlan = (locale: Locale, report: DiffReport): readonly string[] =>
  (report.evidence.impactPlan ?? []).flatMap((item) => [
    message(locale, "diff.plan", { file: item.file, contracts: item.publicContracts.length > 0 ? message(locale, "diff.publicContracts", { contracts: item.publicContracts.join(locale === "zh" ? "，" : ", ") }) : message(locale, "diff.noPublicContracts") }),
    ...item.symbolConsumers.map((evidence) => renderSymbolEvidence(locale, evidence)),
    ...item.actions.map((action) => message(locale, "diff.planAction", { action: renderAction(locale, action) })),
  ]);

/** 变更面 per-file 对齐表格（数学美：列对齐 + 数值右对齐）。 */
const changeSurfaceRows = (collection: NonNullable<DiffReport["evidence"]["changeSurfaces"]>): readonly (readonly string[])[] =>
  collection.surfaces.map((surface) => {
    const confirmed = new Set([...surface.result.consumersByAnchor.values()].flat()).size;
    return [surface.file, surface.language, surface.result.total.toFixed(1), String(surface.staticBound ?? "-"), String(confirmed)];
  });

/** 单个变更锚点的消费者明细（静态上界 vs 符号级确认的对照消息）。 */
const contributionConsumers = (locale: Locale, surface: ChangeSurfaceEntry, contribution: ChangeSurfaceContribution): string =>
  contribution.consumers.length > 0
    ? contribution.consumers.length > surface.staticBound
      ? message(locale, "diff.changeSurfaceConfirmedBeyondBound", { count: contribution.consumers.length, list: contribution.consumers.join(", "), bound: surface.staticBound })
      : contribution.consumers.join(", ")
    : contribution.unconfirmed
      ? message(locale, "diff.changeSurfaceUnconfirmed", { bound: surface.staticBound })
      : message(locale, "diff.changeSurfaceNoConsumers");

/** 单文件变更面的贡献明细（公式展开：λ × log2(n+1) × ω → value）。 */
const renderSurfaceContributions = (locale: Locale, surface: ChangeSurfaceEntry): readonly string[] =>
  surface.result.contributions.map((contribution) => message(locale, "diff.changeSurfaceContribution", {
    anchor: contribution.anchor, kind: contribution.kind,
    lambda: contribution.lambdaAst, consumerCount: contribution.consumers.length,
    reach: contribution.reachFactor.toFixed(3), weight: contribution.layerWeight.toFixed(2),
    value: contribution.contribution.toFixed(1), consumers: contributionConsumers(locale, surface, contribution),
  }));

/** I_push vs C_push 差异信号（file-heavy / symbol-heavy）。 */
const renderSurfaceSignals = (locale: Locale, surface: ChangeSurfaceEntry, deltaByFile: ReadonlyMap<string, number>): readonly string[] => {
  const deltaI = deltaByFile.get(surface.file) ?? 0;
  const cPush = surface.result.total;
  if (deltaI > 0 && cPush > deltaI * 2) {
    return [message(locale, "diff.changeSurfaceSignalSymbolHeavy", { file: surface.file, cPush: cPush.toFixed(1), iPush: deltaI.toFixed(1) })];
  }
  if (deltaI > 0 && cPush < deltaI * 0.5) {
    return [message(locale, "diff.changeSurfaceSignalFileHeavy", { file: surface.file, iPush: deltaI.toFixed(1), cPush: cPush.toFixed(1) })];
  }
  return [];
};

/** C_push 变更面冲击：per-file 表格 + 公式行 + I_push 差异信号 + 不可用语言（无兜底，不误导）。 */
const renderChangeSurfaces = (locale: Locale, report: DiffReport): readonly string[] => {
  const collection = report.evidence.changeSurfaces;
  if (!collection) return [];
  const lines = [...collection.unavailableLanguages.map((entry) =>
    message(locale, "diff.changeSurfaceUnavailable", { language: entry.language, reason: entry.reason }))];
  if (collection.surfaces.length === 0) return lines;
  const total = collection.surfaces.reduce((sum, surface) => sum + surface.result.total, 0);
  const deltaByFile = new Map(report.summary.deltas.map((delta) => [delta.file, delta.deltaI]));
  lines.push(message(locale, "diff.changeSurface", { total: total.toFixed(1), provenance: "symbol" }));
  lines.push(...renderAlignedTable(
    [
      { header: "file" },
      { header: "lang", align: "right" },
      { header: "total", align: "right" },
      { header: "bound", align: "right" },
      { header: "confirmed", align: "right" },
    ],
    changeSurfaceRows(collection),
    { indent: "  " },
  ));
  for (const surface of collection.surfaces) {
    lines.push(...renderSurfaceContributions(locale, surface), ...renderSurfaceSignals(locale, surface, deltaByFile));
  }
  return lines;
};

const renderSymbolEvidence = (locale: Locale, evidence: SymbolConsumerEvidence): string =>
  message(locale, "diff.symbolEvidence", {
    symbol: evidence.symbol,
    provider: evidence.providerId,
    source: evidence.evidenceSource.toUpperCase(),
    declarations: evidence.declarationsCoverage.toUpperCase(),
    references: evidence.repositoryReferencesCoverage.toUpperCase(),
    consumers: evidence.consumers.length > 0 ? evidence.consumers.join(", ") : message(locale, "diff.symbolNoConsumers"),
    comparison: message(locale, "diff.symbolComparison", {
      static: evidence.staticImportConsumers.length > 0 ? evidence.staticImportConsumers.join(", ") : "-",
      shared: evidence.sharedConsumers.length > 0 ? evidence.sharedConsumers.join(", ") : "-",
      staticOnly: evidence.staticOnlyConsumers.length > 0 ? evidence.staticOnlyConsumers.join(", ") : "-",
      symbolOnly: evidence.symbolOnlyConsumers.length > 0 ? evidence.symbolOnlyConsumers.join(", ") : "-",
    }),
    risk: evidence.reason ? message(locale, "diff.symbolRisk", { reason: evidence.reason }) : "",
  });

const renderAnalysisPath = (locale: Locale, reports: readonly SymbolUseReport[] | undefined): readonly string[] => {
  if (reports === undefined) return [message(locale, "diff.staticPath")];
  if (reports.length === 0) return [message(locale, "diff.semanticNoReports")];
  return reports.map((report) => report.state.availability === "unavailable"
    ? message(locale, "diff.semanticFallback", { language: report.origin.language, provider: report.origin.providerId, reason: report.state.reason ?? message(locale, "diff.semanticReasonUnavailable") })
    : message(locale, "diff.semanticPath", {
      language: report.origin.language,
      provider: report.origin.providerId,
      source: report.origin.evidenceSource.toUpperCase(),
      availability: report.state.availability.toUpperCase(),
      declarations: report.state.coverage.declarations.toUpperCase(),
      references: report.state.coverage.repositoryReferences.toUpperCase(),
      scope: report.scope
        ? message(locale, "diff.semanticScope", { mode: report.scope.mode, selected: report.scope.selectedDeclarationFileCount, governed: report.scope.governedFileCount, families: report.scope.declarationFamilies.join(",") })
        : message(locale, "diff.semanticScopeLegacy"),
      risk: report.state.reason ? message(locale, "diff.semanticRisk", { reason: report.state.reason }) : "",
    }));
};

const admissionRequirementLabel = (locale: Locale, id: SymbolScopeAdmissionRequirementId): string =>
  message(locale, `diff.symbolAdmissionRequirement.${id}`);

const renderSymbolScopeAdmissions = (locale: Locale, report: DiffReport): readonly string[] => {
  const admissions = report.evidence.symbolScopeAdmissions;
  if (!admissions || admissions.length === 0) return [];
  return [
    message(locale, "diff.symbolAdmissionHeading"),
    ...admissions.map((admission) => message(locale, "diff.symbolAdmission", {
      file: admission.file,
      symbol: admission.symbol,
      language: admission.language,
      provider: admission.providerId,
      availability: admission.availability.toUpperCase(),
      missing: admission.requirements.filter((requirement) => requirement.availability !== "available")
        .map((requirement) => admissionRequirementLabel(locale, requirement.id)).join(locale === "zh" ? "、" : ", "),
    })),
  ];
};

export interface DiffReportView {
  /** Detail is opt-in so routine check output retains one decision-oriented shape. */
  readonly detail?: boolean;
}

const renderCore = (report: DiffReport, locale: Locale): readonly string[] => [
  message(locale, "diff.heading", { impact: report.summary.iPush.toFixed(1), diagnosis: renderSummary(locale, report), files: report.summary.deltas.length }),
  ...report.summary.deltas
    .filter((delta) => delta.deltaI !== 0)
    .map((delta) => message(locale, "diff.delta", { file: delta.file, impact: delta.deltaI.toFixed(1), alpha: delta.alphaStruct.toFixed(3) })),
  ...renderAnalysisPath(locale, report.evidence.symbolUseReports),
  ...renderPlan(locale, report),
  ...renderChangeSurfaces(locale, report),
  message(locale, "diff.evidence", { state: report.summary.evidenceState === "pending" ? message(locale, "diff.pendingEvidence") : message(locale, "diff.history"), id: report.summary.historyEntryId }),
];

/**
 * Summary is the routine Agent-facing view. Detail is evidence drill-down,
 * never a second metric or policy path.
 */
export const renderDiffReport = (report: DiffReport, locale: Locale = "zh", view: DiffReportView = { detail: true }): readonly string[] => [
  ...renderCore(report, locale),
  ...(view.detail ? [
    ...report.evidence.mrDetail.map((detail) => renderMRDetail(locale, detail)),
    ...renderSymbolScopeAdmissions(locale, report),
  ] : []),
];
