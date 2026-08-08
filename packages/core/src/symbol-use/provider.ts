import { Effect } from "effect";
import type { Language } from "../domain/ast";
import type { ParserService } from "../port/ParserService";
import type { SymbolUseRequest } from "../port/SymbolUseService";
import type { SymbolUseEvidenceSource, SymbolUseReport } from "./types";
import type { SemanticToolchainFact } from "../toolchain/types";

/**
 * Provider selection is declarative. Discovery proves only local prerequisites;
 * the provider still owns project initialization and coverage evidence.
 */
export interface SymbolUseProviderDescriptor {
  readonly id: string;
  readonly evidenceSource: SymbolUseEvidenceSource;
  readonly languages: readonly Language[];
  readonly requiredToolchains: readonly string[];
}

/** Runtime-owned facts shared with providers; providers must not rediscover toolchains or reparse declarations ad hoc. */
export interface SymbolUseProviderContext {
  readonly parser?: ParserService;
  readonly toolchains: ReadonlyMap<string, SemanticToolchainFact>;
}

/** Language adapters own compiler/runtime semantics; the application only consumes this shared report contract. */
export interface SymbolUseProvider extends SymbolUseProviderDescriptor {
  readonly collect: (input: SymbolUseRequest, context: SymbolUseProviderContext) => Effect.Effect<SymbolUseReport>;
}
