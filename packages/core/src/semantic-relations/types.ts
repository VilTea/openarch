import type { Language } from "../domain/ast";
import type { SemanticEvidenceEnvelope } from "../semantic-evidence/types";

/**
 * A provider-owned symbol identity. It is stable within one analyzed workspace
 * fingerprint, but deliberately is not a cross-language global identifier.
 */
export interface SemanticRelationSymbol {
  readonly id: string;
  readonly name: string;
  readonly kind: "class" | "interface" | "type_alias";
  readonly scope: "repository" | "external";
  readonly file?: string;
  readonly line?: number;
}

/** Direct, statically resolved relationships only. No transitive or runtime edge is implied. */
export type SemanticRelationKind =
  | "extends"
  | "implements"
  | "field_type"
  | "parameter_type"
  | "return_type"
  | "instantiates";

export interface SemanticRelationFact {
  readonly language: Language;
  readonly kind: SemanticRelationKind;
  readonly source: SemanticRelationSymbol;
  readonly target: SemanticRelationSymbol;
  readonly direct: true;
  /** The source location of the syntactic relation, not a text-search estimate. */
  readonly evidence: { readonly file: string; readonly line: number };
}

export interface SemanticRelationCoverage {
  readonly symbols: "complete" | "partial" | "unavailable";
  readonly relations: "complete" | "partial" | "unavailable";
}

export interface SemanticRelationScope {
  readonly workspaceFingerprint?: string;
}

/**
 * A bounded semantic snapshot. `complete` only applies to the provider's
 * documented direct-static scope; it never implies whole-program data-flow.
 */
export interface SemanticRelationReport extends SemanticEvidenceEnvelope<Language, SemanticRelationCoverage, SemanticRelationFact, SemanticRelationScope> {}
