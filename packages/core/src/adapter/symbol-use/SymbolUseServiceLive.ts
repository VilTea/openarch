import { Effect, Layer, Option } from "effect";
import type { Language } from "../../domain/ast";
import { ParserService } from "../../port/ParserService";
import { SemanticToolchainDiscovery } from "../../port/SemanticToolchainDiscovery";
import { SymbolUseService, type SymbolUseRequest } from "../../port/SymbolUseService";
import type { SymbolUseProvider, SymbolUseProviderDescriptor } from "../../symbol-use/provider";
import type { SymbolUseReport } from "../../symbol-use/types";
import type { SemanticToolchainFact, SemanticToolchainReport } from "../../toolchain/types";
import { typeScriptSymbolUseProvider } from "./TypeScriptSymbolUseProvider";
import { pythonSymbolUseProvider } from "./PythonSymbolUseProvider";
import { goSymbolUseProvider } from "./GoSymbolUseProvider";
import { rustSymbolUseProvider } from "./RustSymbolUseProvider";
import { javaSymbolUseProvider } from "./JavaSymbolUseProvider";
import { DEFAULT_ANALYSIS_CONCURRENCY } from "../../infra/boundedConcurrency";

export const PROVIDERS: readonly SymbolUseProvider[] = [
  typeScriptSymbolUseProvider,
  pythonSymbolUseProvider,
  goSymbolUseProvider,
  rustSymbolUseProvider,
  javaSymbolUseProvider,
];

const requiredToolchainsAvailable = (provider: SymbolUseProviderDescriptor, tools: ReadonlyMap<string, SemanticToolchainFact>): boolean =>
  provider.requiredToolchains.every((id) => tools.get(id)?.availability === "available");

const unavailableProviderReason = (
  language: Language,
  providers: readonly SymbolUseProviderDescriptor[],
  tools: ReadonlyMap<string, SemanticToolchainFact>,
): string | undefined => {
  const candidates = providers.filter((provider) => provider.languages.includes(language));
  if (candidates.length === 0) return undefined;
  return candidates.map((provider) => {
    const missing = provider.requiredToolchains.filter((id) => tools.get(id)?.availability !== "available");
    return `${provider.id} prerequisites unavailable: ${missing.join(", ")}`;
  }).join("; ");
};

const unavailable = (language: Language, toolchains?: SemanticToolchainReport, providerReason?: string): SymbolUseReport => ({
  origin: { language, providerId: "none", evidenceSource: "lsp" },
  state: {
    availability: "unavailable",
    coverage: { declarations: "unavailable", repositoryReferences: "unavailable" },
    reason: toolchains
      ? `${providerReason ?? "no installed symbol-use provider for this language"}; toolchains: ${toolchains.tools.map((tool) => `${tool.id}=${tool.availability}`).join(", ")}`
      : "no installed symbol-use provider for this language",
  },
  facts: [],
});

export const SymbolUseServiceLive = Layer.effect(
  SymbolUseService,
  Effect.gen(function* () {
    const discovery = yield* SemanticToolchainDiscovery;
    const collect = (input: SymbolUseRequest): Effect.Effect<readonly SymbolUseReport[]> => Effect.gen(function* () {
      const parser = Option.getOrUndefined(yield* Effect.serviceOption(ParserService));
      const toolchains = yield* discovery.discover({ cwd: input.cwd, languages: input.languages });
      const byLanguage = new Map(toolchains.map((report) => [report.language, report]));
      const tools = new Map(toolchains.flatMap((report) => report.tools.map((tool) => [tool.id, tool] as const)));
      const candidates = PROVIDERS.filter((provider) => provider.languages.some((language) => input.languages.includes(language)));
      const providers = candidates.filter((provider) => requiredToolchainsAvailable(provider, tools));
      const coveredLanguages = new Set(providers.flatMap((provider) => provider.languages));
      const uncovered = input.languages.filter((language) => !coveredLanguages.has(language)).map((language) =>
        unavailable(language, byLanguage.get(language), unavailableProviderReason(language, candidates, tools)));
      const reports = yield* Effect.all(providers.map((provider) => provider.collect(input, { parser, toolchains: tools })), { concurrency: DEFAULT_ANALYSIS_CONCURRENCY });
      return [...reports, ...uncovered];
    });
    return { collect };
  }),
);
