// Definition-surface candidate selection (report-only).
// Shared by the CLI definition-footprint report and the fact-layer similarity
// scan so the "which files are definition-heavy" rule has a single authority.
export interface DefinitionSurfaceMetric {
  readonly path: string;
  readonly language?: string;
  readonly declarationLoc?: number;
  readonly loc?: number;
}

/** Language-level decl/loc P95 thresholds. declP95=0 means no declaration-heavy surface. */
export const languageDefinitionThresholds = (
  metrics: readonly DefinitionSurfaceMetric[],
): ReadonlyMap<string, { readonly declP95: number; readonly locP95: number }> => {
  const byLang = new Map<string, { decl: number; loc: number }[]>();
  for (const metric of metrics) {
    const language = metric.language ?? "unknown";
    const existing = byLang.get(language);
    const row = { decl: metric.declarationLoc ?? 0, loc: metric.loc ?? 0 };
    if (existing) existing.push(row);
    else byLang.set(language, [row]);
  }
  const p95of = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  };
  const thresholds = new Map<string, { declP95: number; locP95: number }>();
  for (const [language, rows] of byLang) {
    thresholds.set(language, { declP95: p95of(rows.map((row) => row.decl)), locP95: p95of(rows.map((row) => row.loc)) });
  }
  return thresholds;
};

export const definitionSurfaceCandidateMetrics = (
  metrics: readonly DefinitionSurfaceMetric[],
): readonly DefinitionSurfaceMetric[] => {
  const thresholds = languageDefinitionThresholds(metrics);
  return metrics
    .filter((metric) => {
      const lang = thresholds.get(metric.language ?? "unknown");
      if (!lang || lang.declP95 === 0) return false;
      return (metric.declarationLoc ?? 0) > lang.declP95 && (metric.loc ?? 0) > lang.locP95;
    })
    .sort((left, right) => (right.declarationLoc ?? 0) - (left.declarationLoc ?? 0));
};

export const definitionSurfaceCandidatePaths = (metrics: readonly DefinitionSurfaceMetric[]): readonly string[] =>
  definitionSurfaceCandidateMetrics(metrics).map((metric) => metric.path);
