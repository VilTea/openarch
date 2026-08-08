/** Shared provenance for report-only semantic facts; language-specific facts stay in their owning domain. */
export interface SemanticEvidenceOrigin<LanguageId extends string = string> {
  readonly language: LanguageId;
  /** Provider identity is part of the evidence boundary, not display metadata. */
  readonly providerId: string;
  readonly evidenceSource: "compiler" | "lsp" | "scip";
}

/** Availability, coverage, and limits must travel together so a fact is not consumed beyond its evidence boundary. */
export interface SemanticEvidenceState<Coverage> {
  readonly availability: "available" | "partial" | "unavailable";
  readonly coverage: Coverage;
  readonly reason?: string;
}

/**
 * Common envelope for ephemeral semantic reports. It is intentionally not a
 * persisted schema or a cross-process protocol.
 */
export interface SemanticEvidenceEnvelope<LanguageId extends string, Coverage, Fact, Scope = never> {
  readonly origin: SemanticEvidenceOrigin<LanguageId>;
  readonly state: SemanticEvidenceState<Coverage>;
  readonly facts: readonly Fact[];
  readonly scope?: Scope;
}
