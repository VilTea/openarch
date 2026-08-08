import { Context, Effect } from "effect";
import type { SemanticToolchainDiscoveryRequest, SemanticToolchainReport } from "../toolchain/types";

/** Read-only local toolchain facts. Starting LSP servers and collecting symbols remain provider responsibilities. */
export interface SemanticToolchainDiscovery {
  readonly discover: (request: SemanticToolchainDiscoveryRequest) => Effect.Effect<readonly SemanticToolchainReport[]>;
}

export const SemanticToolchainDiscovery = Context.GenericTag<"SemanticToolchainDiscovery", SemanticToolchainDiscovery>("SemanticToolchainDiscovery");
