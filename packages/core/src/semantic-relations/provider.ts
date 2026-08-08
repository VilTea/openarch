import type { Language } from "../domain/ast";
import type { SemanticRelationReport } from "./types";

export interface SemanticRelationRequest {
  readonly cwd: string;
  readonly languages: readonly Language[];
}

export interface SemanticRelationProvider {
  readonly id: string;
  readonly languages: readonly Language[];
  readonly collect: (input: SemanticRelationRequest) => SemanticRelationReport;
}
