import { Effect, Layer } from "effect";
import { SemanticToolchainDiscovery } from "../../port/SemanticToolchainDiscovery";
import { discoverSemanticToolchains } from "../../toolchain/discovery";
import { nodeToolchainRuntime } from "./NodeToolchainRuntime";

export const SemanticToolchainDiscoveryLive = Layer.succeed(SemanticToolchainDiscovery, {
  discover: (request) => Effect.sync(() => discoverSemanticToolchains(request.cwd, request.languages, nodeToolchainRuntime)),
});
