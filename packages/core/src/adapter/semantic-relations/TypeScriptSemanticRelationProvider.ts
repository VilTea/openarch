import type { SemanticRelationProvider } from "../../semantic-relations/provider";
import { collectTypeScriptSemanticRelations } from "../../semantic-relations/typescript";

export const typeScriptSemanticRelationProvider: SemanticRelationProvider = {
  id: "typescript-semantic-relations",
  languages: ["typescript"],
  collect: (input) => collectTypeScriptSemanticRelations(input.cwd),
};
