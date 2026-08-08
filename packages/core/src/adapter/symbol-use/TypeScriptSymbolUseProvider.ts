import { Effect } from "effect";
import type { SymbolUseRequest } from "../../port/SymbolUseService";
import type { SymbolUseProvider } from "../../symbol-use/provider";
import { collectTypeScriptSymbolUse } from "../../symbol-use/typescriptCollection";

const reportLanguage = (input: SymbolUseRequest): "typescript" | "javascript" =>
  input.languages.includes("typescript") ? "typescript" : "javascript";

export const typeScriptSymbolUseProvider: SymbolUseProvider = {
  id: "typescript-symbol-use",
  evidenceSource: "compiler",
  languages: ["typescript", "javascript"],
  requiredToolchains: ["typescript-compiler"],
  collect: (input) => Effect.try({
    try: () => collectTypeScriptSymbolUse(input.cwd, reportLanguage(input), input.demand),
    catch: (error) => error,
  }).pipe(Effect.catchAll((error) => Effect.succeed({
    origin: { language: reportLanguage(input), providerId: "typescript-symbol-use", evidenceSource: "compiler" as const },
    state: { availability: "unavailable" as const, coverage: { declarations: "unavailable" as const, repositoryReferences: "unavailable" as const }, reason: error instanceof Error ? error.message : String(error) },
    facts: [],
  }))),
};
