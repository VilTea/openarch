import { describe, it, expect } from "vitest";
import { nodeToolchainRuntime } from "../../../src/adapter/toolchain/NodeToolchainRuntime";

describe("nodeToolchainRuntime.hasPackage（A2 回归：bun bundle / node 双环境）", () => {
  it("存在且可加载的包 → true（typescript 由 core 静态 import，两种环境至少一种路径可解析）", () => {
    expect(nodeToolchainRuntime.hasPackage("typescript")).toBe(true);
  });

  it("不存在的包 → false", () => {
    expect(nodeToolchainRuntime.hasPackage("openarch-no-such-package-xyz")).toBe(false);
  });
});
