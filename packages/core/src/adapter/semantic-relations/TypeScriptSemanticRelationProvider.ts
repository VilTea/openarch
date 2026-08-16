import { Effect } from "effect";
import type { SemanticRelationProvider } from "../../semantic-relations/provider";
import { collectTypeScriptSemanticRelations } from "../../semantic-relations/typescript";

export const typeScriptSemanticRelationProvider: SemanticRelationProvider = {
  id: "typescript-semantic-relations",
  evidenceSource: "compiler",
  languages: ["typescript"],
  requiredToolchains: [],
  collect: (input) => Effect.sync(() => collectTypeScriptSemanticRelations(input.cwd)),
};
