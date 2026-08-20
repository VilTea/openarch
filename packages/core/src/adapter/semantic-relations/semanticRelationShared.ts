import type { QueryCapture, QueryMatch } from "../../port/ParserService";
import type { SemanticRelationFact, SemanticRelationReport } from "../../semantic-relations/types";

/** Shared LSP timeout contract for all semantic-relation providers. */
export const DIAGNOSTIC_READINESS_TIMEOUT_MS = Number(process.env.OPENARCH_LSP_INDEX_TIMEOUT_MS ?? 180_000);
export const LSP_REQUEST_TIMEOUT_MS = Number(process.env.OPENARCH_LSP_REQUEST_TIMEOUT_MS ?? 120_000);

export const captureOf = (match: QueryMatch, name: string): QueryCapture | undefined =>
  match.captures.find((capture) => capture.name === name);

/** Deduplicate and order relation facts by evidence/kind/source/target identity. */
export const uniqueFacts = (facts: readonly SemanticRelationFact[]): readonly SemanticRelationFact[] => {
  const byIdentity = new Map<string, SemanticRelationFact>();
  for (const fact of facts) {
    const key = `${fact.source.id}\0${fact.kind}\0${fact.target.id}\0${fact.evidence.file}\0${fact.evidence.line}`;
    byIdentity.set(key, fact);
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.evidence.file.localeCompare(right.evidence.file)
    || left.evidence.line - right.evidence.line
    || left.kind.localeCompare(right.kind)
    || left.source.id.localeCompare(right.source.id)
    || left.target.id.localeCompare(right.target.id));
};

/** Build a provider-owned unavailable report with the correct origin identity. */
export const unavailableFor = (
  origin: SemanticRelationReport["origin"],
  reason: string,
): SemanticRelationReport => ({
  origin,
  state: { availability: "unavailable", coverage: { symbols: "unavailable", relations: "unavailable" }, reason },
  facts: [],
});
