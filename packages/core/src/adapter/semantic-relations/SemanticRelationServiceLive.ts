import { Effect, Layer } from "effect";
import type { Language } from "../../domain/ast";
import { SemanticRelationService } from "../../port/SemanticRelationService";
import type { SemanticRelationProvider } from "../../semantic-relations/provider";
import type { SemanticRelationReport } from "../../semantic-relations/types";
import { typeScriptSemanticRelationProvider } from "./TypeScriptSemanticRelationProvider";

const PROVIDERS: readonly SemanticRelationProvider[] = [typeScriptSemanticRelationProvider];

const unavailable = (language: Language): SemanticRelationReport => ({
  origin: { language, providerId: "none", evidenceSource: "lsp" },
  state: { availability: "unavailable", coverage: { symbols: "unavailable", relations: "unavailable" }, reason: "no calibrated semantic-relation provider for this language" },
  facts: [],
});

/** Provider selection is centralized so future LSP/SCIP adapters do not fork script facts or reports. */
export const SemanticRelationServiceLive = Layer.succeed(
  SemanticRelationService,
  {
    collect: (input) => Effect.sync(() => {
      const reports = PROVIDERS
        .filter((provider) => provider.languages.some((language) => input.languages.includes(language)))
        .map((provider) => provider.collect(input));
      const supported = new Set(PROVIDERS.flatMap((provider) => provider.languages));
      return [...reports, ...input.languages.filter((language) => !supported.has(language)).map(unavailable)];
    }),
  },
);
