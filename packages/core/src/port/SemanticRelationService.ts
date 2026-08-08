import { Context, type Effect } from "effect";
import type { SemanticRelationRequest } from "../semantic-relations/provider";
import type { SemanticRelationReport } from "../semantic-relations/types";

/** Optional typed semantic graph capability. It is separate from structural baseline metrics. */
export class SemanticRelationService extends Context.Tag("SemanticRelationService")<
  SemanticRelationService,
  { readonly collect: (input: SemanticRelationRequest) => Effect.Effect<readonly SemanticRelationReport[]> }
>() {}
