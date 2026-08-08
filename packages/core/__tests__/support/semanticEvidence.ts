interface SemanticEvidenceLike {
  readonly origin: Record<string, unknown>;
  readonly state: Record<string, unknown>;
  readonly scope?: Record<string, unknown>;
  readonly facts: readonly unknown[];
}

/** Keeps legacy value assertions concise while dedicated tests assert the envelope's raw shape. */
export const semanticEvidenceView = (report: SemanticEvidenceLike) => ({
  ...report,
  ...report.origin,
  ...report.state,
  ...(report.scope ?? {}),
});
