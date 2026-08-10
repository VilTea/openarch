import { Effect, Layer } from "effect";
import { SemanticToolchainDiscovery } from "../../port/SemanticToolchainDiscovery";
import { discoverSemanticToolchainsAsync } from "../../toolchain/discovery";
import { nodeToolchainRuntime } from "./NodeToolchainRuntime";

export const SemanticToolchainDiscoveryLive = Layer.succeed(SemanticToolchainDiscovery, {
  // A2 修复：异步 discovery（bun 二进制同步探测失败，TS 用动态 import 检测）
  discover: (request) => Effect.promise(() => discoverSemanticToolchainsAsync(request.cwd, request.languages, nodeToolchainRuntime)),
});
