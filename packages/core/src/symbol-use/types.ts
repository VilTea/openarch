import type { SemanticEvidenceEnvelope, SemanticEvidenceOrigin, SemanticEvidenceState } from "../semantic-evidence/types";

export type SymbolUseAvailability = SemanticEvidenceState<unknown>["availability"];
export type SymbolUseEvidenceSource = SemanticEvidenceOrigin["evidenceSource"];
export type SymbolUseCoverage = "complete" | "partial" | "unavailable";
export type SymbolUseDeclarationFamily = "callable" | "type" | "property";

export interface SymbolUseScope {
  /** A bounded revision question is useful evidence, but never a repository-complete population. */
  readonly mode: "repository" | "demand";
  readonly governedFileCount: number;
  readonly selectedDeclarationFileCount: number;
  /** Syntax varies by language; consumers compare declared families, not provider implementation. */
  readonly declarationFamilies: readonly SymbolUseDeclarationFamily[];
}

export interface SymbolReference {
  readonly file: string;
  readonly line: number;
}

export interface SymbolUseFact {
  readonly language: string;
  readonly declaration: {
    readonly file: string;
    readonly name: string;
    /** Kinds are intentionally narrow: a provider may add one only with stable declaration and reference evidence. */
    readonly kind: "interface-property" | "interface-method" | "type-property" | "type-method" | "function" | "class" | "method" | "accessor" | "class-property-function" | "object-property-function";
    readonly line: number;
  };
  readonly repositoryReferences: readonly SymbolReference[];
  readonly publicSurface: "internal" | "declared-public" | "unknown";
}

export interface SymbolUseCoverageSummary {
  /** Declaration and reference coverage are independent; only both-complete facts can support symbol_scope. */
  readonly declarations: SymbolUseCoverage;
  readonly repositoryReferences: SymbolUseCoverage;
  /** Structured evidence that reference collection was incomplete (LSP index not ready / request failures),
   *  replacing string-matching on reason prose for reliability judgments (spec 2026-08). */
  readonly incompleteReferences?: boolean;
}

/** New providers must declare their selected population and fact families. Legacy reports have no scope claim. */
export interface SymbolUseReport extends SemanticEvidenceEnvelope<string, SymbolUseCoverageSummary, SymbolUseFact, SymbolUseScope> {}

export const symbolUseDeclarationFamily = (kind: SymbolUseFact["declaration"]["kind"]): SymbolUseDeclarationFamily => {
  if (kind === "class") return "type";
  if (kind === "interface-property" || kind === "type-property") return "property";
  return "callable";
};

export const symbolUseFamiliesFor = (kinds: readonly SymbolUseFact["declaration"]["kind"][]): readonly SymbolUseDeclarationFamily[] =>
  [...new Set(kinds.map(symbolUseDeclarationFamily))].sort();

export const symbolUseScopeFor = (
  mode: SymbolUseScope["mode"],
  governedFileCount: number,
  selectedDeclarationFileCount: number,
  kinds: readonly SymbolUseFact["declaration"]["kind"][],
): SymbolUseScope => ({ mode, governedFileCount, selectedDeclarationFileCount, declarationFamilies: symbolUseFamiliesFor(kinds) });
