import { Effect, Layer, Option } from "effect";
import type { Language } from "../../domain/ast";
import { ParserService } from "../../port/ParserService";
import { SemanticRelationService } from "../../port/SemanticRelationService";
import { SemanticToolchainDiscovery } from "../../port/SemanticToolchainDiscovery";
import type { SemanticRelationProvider } from "../../semantic-relations/provider";
import type { SemanticRelationReport } from "../../semantic-relations/types";
import { typeScriptSemanticRelationProvider } from "./TypeScriptSemanticRelationProvider";
import { pythonSemanticRelationProvider } from "./PythonSemanticRelationProvider";
import { goSemanticRelationProvider } from "./GoSemanticRelationProvider";
import { javaSemanticRelationProvider } from "./JavaSemanticRelationProvider";
import { rustSemanticRelationProvider } from "./RustSemanticRelationProvider";
import { DEFAULT_ANALYSIS_CONCURRENCY } from "../../infra/boundedConcurrency";

export const PROVIDERS: readonly SemanticRelationProvider[] = [
  typeScriptSemanticRelationProvider,
  pythonSemanticRelationProvider,
  goSemanticRelationProvider,
  javaSemanticRelationProvider,
  rustSemanticRelationProvider,
];

const unavailable = (language: Language, reason: string): SemanticRelationReport => ({
  origin: { language, providerId: "none", evidenceSource: "lsp" },
  state: { availability: "unavailable", coverage: { symbols: "unavailable", relations: "unavailable" }, reason },
  facts: [],
});

/** Provider selection is centralized so future LSP/SCIP adapters do not fork script facts or reports. */
export const SemanticRelationServiceLive = Layer.effect(
  SemanticRelationService,
  Effect.gen(function* () {
    const discovery = yield* SemanticToolchainDiscovery;
    const collect = (input: { readonly cwd: string; readonly languages: readonly Language[] }): Effect.Effect<readonly SemanticRelationReport[]> =>
      Effect.gen(function* () {
        const parser = Option.getOrUndefined(yield* Effect.serviceOption(ParserService));
        const toolchainReports = yield* discovery.discover({ cwd: input.cwd, languages: input.languages });
        const tools = new Map(toolchainReports.flatMap((report) => report.tools.map((tool) => [tool.id, tool] as const)));
        const candidates = PROVIDERS.filter((provider) => provider.languages.some((language) => input.languages.includes(language)));
        const selected = candidates.filter((provider) => provider.requiredToolchains.every((id) => tools.get(id)?.availability === "available"));
        const covered = new Set(selected.flatMap((provider) => provider.languages));
        const reports = yield* Effect.all(
          selected.map((provider) => provider.collect(input, { parser, toolchains: tools })),
          { concurrency: DEFAULT_ANALYSIS_CONCURRENCY },
        );
        const uncovered = input.languages.filter((language) => !covered.has(language)).map((language) => {
          const missing = candidates
            .filter((provider) => provider.languages.includes(language))
            .flatMap((provider) => provider.requiredToolchains.filter((id) => tools.get(id)?.availability !== "available"));
          return unavailable(
            language,
            missing.length > 0
              ? `${candidates.filter((provider) => provider.languages.includes(language)).map((provider) => provider.id).join("; ")} prerequisites unavailable: ${missing.join(", ")}`
              : "no calibrated semantic-relation provider for this language",
          );
        });
        return [...reports, ...uncovered];
      });
    return { collect };
  }),
);
