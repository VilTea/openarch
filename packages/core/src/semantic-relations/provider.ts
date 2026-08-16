import type { Effect } from "effect";
import type { Language } from "../domain/ast";
import type { ParserService } from "../port/ParserService";
import type { SemanticToolchainFact } from "../toolchain/types";
import type { SemanticRelationReport } from "./types";

export interface SemanticRelationRequest {
  readonly cwd: string;
  readonly languages: readonly Language[];
}

export interface SemanticRelationProviderContext {
  readonly parser?: ParserService;
  readonly toolchains: ReadonlyMap<string, SemanticToolchainFact>;
}

export interface SemanticRelationProvider {
  readonly id: string;
  /** LSP/compiler evidence source; never defaults to a textual approximation. */
  readonly evidenceSource: "compiler" | "lsp";
  readonly languages: readonly Language[];
  /** Toolchain ids that must be available before the provider is selected. */
  readonly requiredToolchains: readonly string[];
  readonly collect: (
    input: SemanticRelationRequest,
    context: SemanticRelationProviderContext,
  ) => Effect.Effect<SemanticRelationReport, never>;
}
