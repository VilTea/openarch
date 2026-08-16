// @ts-nocheck —— 插件包无独立 tsconfig，本文件以 vitest 转译运行。
// 契约测试（运行时面）：manifest 是工具/占位/信号声明的单一事实源，
// 这里交叉校验实现与 manifest 一致，替代散落在各测试里的硬编码期望。
// schema/manifest/状态的静态防漂移校验见 openarch-schemas.test.ts。
import { describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configKeys, strictConfig } from "../host/openarch-contract.mjs";

/** dsh/ 目录。 */
const dshDir = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = join(dshDir, "examples", "dsh-plugin.manifest.json");
const loadManifest = () => JSON.parse(readFileSync(manifestPath, "utf8"));

const deepEqual = (left, right) => {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (typeof left !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, i) => key !== rightKeys[i])) return false;
  return leftKeys.every((key) => deepEqual(left[key], right[key]));
};

const cannedContext = {
  configuration: "available",
  schema: "context-json-v1",
  baseline: { available: true, files: 547, scope: "compatible", freshness: "stale", scanAt: "2026-08-11T21:03:20.936Z" },
  architecturePolicy: { state: "configured", declaredRules: 14 },
  changes: {
    worktree: { availability: "available", paths: 57, sourcePaths: 20 },
    staged: { availability: "available", paths: 0, sourcePaths: 0 },
  },
};

const freshTmpDir = () => mkdtempSync(join(tmpdir(), "openarch-contract-"));

/** 工具层 fake ctx（复用 openarch-tools.test.ts 的接缝约定）。 */
function fakeToolsCtx() {
  const tools = { register: vi.fn(() => () => {}) };
  const sections = [];
  const services = new Map();
  services.set("openarch.exec", {
    execFile: async (file, args) => {
      if (args.includes("context")) return { stdout: JSON.stringify(cannedContext), stderr: "" };
      const error = new Error("exit 0");
      error.code = 0;
      error.stdout = "report";
      error.stderr = "";
      throw error;
    },
  });
  services.set("openarch.cwd", { value: freshTmpDir() });
  services.set("systemPrompt", { section: vi.fn((reg) => { sections.push(reg); return () => {}; }) });
  services.set("harness", { handle: vi.fn(() => () => {}) });
  return { ctx: { get: (key) => services.get(key), effect: () => {}, tools }, tools, sections };
}

describe("契约：manifest ↔ 模块导出", () => {
  it("模块 entry 存在，且导出的 name/inject 与 manifest 一致", async () => {
    const manifest = loadManifest();
    for (const module of manifest.modules) {
      const entry = resolve(dshDir, module.entry);
      expect(existsSync(entry), `entry 缺失: ${module.entry}`).toBe(true);
      const mod = await import(pathToFileURL(entry).href);
      expect(mod.name, `${module.entry} 应导出 name`).toBe(module.id);
      expect([...(mod.inject ?? [])].sort()).toEqual([...module.inject].sort());
    }
  });
});

describe("契约：manifest ↔ 工具注册面", () => {
  it("openarch-tools 注册的工具与 manifest.tools 逐项一致（名称/描述/参数/输出 schema/超时/并发）", async () => {
    const manifest = loadManifest();
    const { apply } = await import("../host/openarch-tools.mjs");
    const { ctx, tools } = fakeToolsCtx();
    apply(ctx, { openarchBin: "openarch", stateTtlMs: 60_000 });
    const byName = {};
    for (const call of tools.register.mock.calls) byName[call[0].name] = call[0];
    const manifestByName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
    expect(Object.keys(byName).sort()).toEqual([...manifestByName.keys()].sort());
    for (const [name, tool] of Object.entries(byName)) {
      const declared = manifestByName.get(name);
      expect(tool.description).toBe(declared.description);
      expect(deepEqual(tool.parameters, declared.parameters), `${name} parameters 与 manifest 不一致`).toBe(true);
      expect(deepEqual(tool.output.schema, declared.outputSchema), `${name} outputSchema 与 manifest 不一致`).toBe(true);
      expect(tool.timeoutMs).toBe(declared.timeoutMs);
      const concurrencySafe = tool.isConcurrencySafe({}) === true;
      expect(concurrencySafe ? "safe" : "exclusive").toBe(declared.concurrency);
    }
  });
});

describe("契约：manifest ↔ prompt section / slot 注册", () => {
  it("prompt section 注册（tools + signals 合并视角）与 manifest.promptSections 一致", async () => {
    const manifest = loadManifest();
    const { apply: toolsApply } = await import("../host/openarch-tools.mjs");
    const { apply: signalsApply } = await import("../host/openarch-signals.mjs");
    const toolsEnv = fakeToolsCtx();
    toolsApply(toolsEnv.ctx, { openarchBin: "openarch", stateTtlMs: 60_000 });
    const signalsSections = [];
    const signalsCtx = {
      systemPrompt: { section: vi.fn((reg) => { signalsSections.push(reg); return () => {}; }) },
      interval: vi.fn(() => () => {}),
      get: () => undefined,
    };
    signalsApply(signalsCtx, { cwd: freshTmpDir() });
    const registered = [...toolsEnv.sections, ...signalsSections].map((s) => ({ name: s.name, order: s.order }));
    const declared = manifest.promptSections.map((s) => ({ name: s.name, order: s.order }));
    expect(registered.sort((a, b) => a.order - b.order)).toEqual(declared.sort((a, b) => a.order - b.order));
  });

  it("client 的 slot 注册与 manifest.slots 一致", async () => {
    const manifest = loadManifest();
    const { apply } = await import("../client/openarch-dashboard.mjs");
    const registrations = [];
    const slots = {
      inject: vi.fn((_slot, cb) => cb()),
      register: vi.fn((opts) => { registrations.push(opts); }),
    };
    const ctx = {
      get: (key) => (key === "slots" ? slots : undefined),
      effect: () => {},
      interval: vi.fn(() => () => {}),
    };
    apply(ctx, { refreshMs: 20_000 });
    const captured = registrations.map((r) => ({ slot: r.name, id: r.id, order: r.order }));
    const declared = manifest.slots.map((s) => ({ slot: s.slot, id: s.id, order: s.order }));
    const bySlot = (list) => list.sort((a, b) => String(a.slot).localeCompare(String(b.slot)));
    expect(bySlot(captured)).toEqual(bySlot(declared));
  });
});

describe("契约：运行时配置白名单来自 schema（去硬编码）", () => {
  it("strictConfig 保留白名单键、丢弃未知键并 warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const clean = strictConfig({ stateTtlMs: 30_000, typoKey: 1, refreshMs: 5_000 });
      expect(clean).toEqual({ stateTtlMs: 30_000, refreshMs: 5_000 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("typoKey");
    } finally {
      warn.mockRestore();
    }
  });

  it("strictConfig 对非对象输入返回空对象且不抛异常", () => {
    expect(strictConfig(undefined)).toEqual({});
    expect(strictConfig(null)).toEqual({});
  });

  it("configKeys() 非空且包含各模块用到的键", () => {
    const keys = configKeys();
    for (const key of ["openarchBin", "cwd", "stateTtlMs", "refreshMs", "topFiles", "historyKeep", "maxShards", "distributionBins"]) {
      expect(keys.has(key), `缺键 ${key}`).toBe(true);
    }
  });
});
