// @ts-nocheck —— 插件包无独立 tsconfig；本文件以 vitest 转译运行。
// 该测试在 `pnpm test` 中运行；package.json 的 test 脚本先执行
// `build:client`，因此这里可以直接读取构建产物 lib/client.js。
import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("openarch-plugin: DSH client bundle 发布契约", () => {
  it("exports 指向 host 安全入口与已构建 client bundle", () => {
    expect(pkg.exports["."]).toBe("./dsh/host/openarch-dashboard-host.mjs");
    expect(pkg.exports["./client"]).toBe("./lib/client.js");
    expect(pkg.exports["./host-tools"]).toBe("./dsh/host/openarch-tools.mjs");
    expect(pkg.exports["./host-signals"]).toBe("./dsh/host/openarch-signals.mjs");
  });

  it("files 白名单包含 scripts 与 lib，构建产物可随包发布", () => {
    expect(pkg.files).toContain("scripts");
    expect(pkg.files).toContain("lib");
    expect(typeof pkg.scripts["build:client"]).toBe("string");
    expect(typeof pkg.scripts.prepack).toBe("string");
  });

  it("lib/client.js 已构建且按 DSH 自注册契约输出", () => {
    const clientPath = join(root, "lib", "client.js");
    expect(existsSync(clientPath)).toBe(true);
    const content = readFileSync(clientPath, "utf8");
    expect(content).toContain("window.__ModuleLoader__.load({");
    expect(content).toContain(`id: ${JSON.stringify(pkg.name)}`);
    expect(content).toContain("factory:");
  });

  it("bundle 注册 id 为包名，工厂可物化出 name/inject/apply", () => {
    const clientPath = join(root, "lib", "client.js");
    const content = readFileSync(clientPath, "utf8");
    const registrations = [];
    const sandbox = {
      window: {
        __ModuleLoader__: {
          load: (handoff) => registrations.push(handoff),
        },
      },
      Object,
      Symbol,
      JSON,
      console,
    };
    vm.runInNewContext(content, sandbox);
    expect(registrations).toHaveLength(1);
    const { id, factory } = registrations[0];
    expect(id).toBe(pkg.name);

    const reactStub = { createElement: () => null };
    const exportsObj = factory(() => reactStub);
    expect(exportsObj.name).toBe("openarch-dashboard");
    expect(exportsObj.inject).toEqual(["timer", "slots"]);
    expect(typeof exportsObj.apply).toBe("function");
  });

  it("apply can register slots without relying on ctx.get service helper", () => {
    const clientPath = join(root, "lib", "client.js");
    const content = readFileSync(clientPath, "utf8");
    const registrations = [];
    const sandbox = {
      window: {
        __ModuleLoader__: {
          load: (handoff) => registrations.push(handoff),
        },
      },
      Object,
      Symbol,
      JSON,
      console,
    };
    vm.runInNewContext(content, sandbox);
    const { factory } = registrations[0];
    const reactStub = { createElement: () => null };
    const exportsObj = factory(() => reactStub);

    const slots = { inject: vi.fn(() => () => {}), register: vi.fn(() => ({})) };
    const ctx = {
      slots,
      interval: () => () => {},
      effect: () => {},
    };
    expect(() => exportsObj.apply(ctx, {})).not.toThrow();
    expect(slots.inject).toHaveBeenCalledTimes(2);
    expect(slots.inject.mock.calls.map((call) => call[0]).sort()).toEqual([
      "conversation.composer.dock",
      "shell.overlay",
    ]);
  });
});
