// @ts-nocheck —— 插件包无独立 tsconfig，本文件以 vitest 转译运行；
// 被测资产是纯 JavaScript 模块（dsh/host/*.mjs）。
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, name, renderGateText, renderTestText, renderContractText, sessionCwdOf, verdictOf } from "../host/openarch-tools.mjs";

const freshTmpDir = () => mkdtempSync(join(tmpdir(), "openarch-tools-"));

/** 构造最小假 ctx：tools 注册表 + 可选服务映射 + 测试接缝。 */
function fakeCtx(overrides = {}) {
  const tools = { register: vi.fn(() => () => {}) };
  const services = new Map();
  const ctx = {
    get: (key) => services.get(key),
    effect: (callback) => callback?.(),
    tools,
    ...overrides,
  };
  return { ctx, tools, services };
}

/** 固定退出码的假 execFile：context 命令成功，其余按 exitCode reject（携带 stdout/stderr）。 */
function execWithExitCode(exitCode, stdout = "gate report body") {
  return async (file, args) => {
    if (args.includes("context")) {
      return {
        stdout: JSON.stringify({
          configuration: "available",
          schema: "context-json-v1",
          baseline: { available: true, files: 10, scope: "compatible", freshness: "fresh", scanAt: "2026-08-11T00:00:00Z" },
          architecturePolicy: { state: "configured", declaredRules: 3 },
          changes: { worktree: { paths: 2, sourcePaths: 1 }, staged: { paths: 0, sourcePaths: 0 } },
        }),
        stderr: "",
      };
    }
    const error = new Error(`exit ${exitCode}`);
    error.code = exitCode;
    error.stdout = stdout;
    error.stderr = "";
    throw error;
  };
}

/** 假 spawn：记录 stdout data/close 事件句柄，可手动推送输出与结算。 */
function fakeSpawn() {
  const listeners = new Map();
  const dataHandlers = [];
  const child = {
    stdout: { on: (event, handler) => { if (event === "data") dataHandlers.push(handler); } },
    stderr: { on: (event, handler) => { if (event === "data") dataHandlers.push(handler); } },
    kill: vi.fn(),
    on(event, handler) {
      listeners.set(event, handler);
    },
  };
  return { child, listeners, dataHandlers };
}

const mount = (exitCode = 0) => {
  const { ctx, tools, services } = fakeCtx();
  services.set("openarch.exec", { execFile: execWithExitCode(exitCode) });
  services.set("openarch.cwd", { value: freshTmpDir() });
  const section = { section: vi.fn(() => () => {}) };
  services.set("systemPrompt", section);
  const harness = { handle: vi.fn(() => () => {}) };
  services.set("harness", harness);
  const spawned = fakeSpawn();
  services.set("openarch.spawn", { spawn: () => spawned.child });
  apply(ctx, { openarchBin: "openarch", stateTtlMs: 60_000 });
  const byName = {};
  for (const call of tools.register.mock.calls) byName[call[0].name] = call[0];
  return { ctx, tools, services, byName, section, harness, spawned };
};

describe("openarch-tools: 注册面", () => {
  it("注册六个模型工具与工具纪律 section", () => {
    const { byName, section } = mount();
    expect(Object.keys(byName).sort()).toEqual(["openarch_check", "openarch_context", "openarch_contract", "openarch_review", "openarch_scan", "openarch_test"]);
    for (const tool of Object.values(byName)) {
      expect(tool.parameters?.type).toBe("object");
      expect(tool.parameters?.properties).toBeTypeOf("object");
    }
    expect(section.section).toHaveBeenCalledTimes(1);
    const reg = section.section.mock.calls[0][0];
    expect(reg.name).toBe("tool:openarch");
    expect(reg.order).toBe(108);
    expect(reg.text).toContain("openarch_test");
    expect(reg.text).toContain("openarch_contract");
  });

  it("包名符合 DSH 命名约定", () => {
    expect(name).toBe("openarch-tools");
  });

  it("verdict 映射与 CLI 退出码契约一致", () => {
    expect(verdictOf(0)).toBe("PASS");
    expect(verdictOf(1)).toBe("WARN");
    expect(verdictOf(2)).toBe("BLOCK");
    expect(verdictOf(3)).toBe("ERROR");
    expect(verdictOf(null)).toBe("ERROR");
    expect(verdictOf(99)).toBe("ERROR");
  });
});

describe("openarch-tools: openarch_context", () => {
  it("返回 CLI context 契约与初始化状态", async () => {
    const { byName } = mount();
    const value = await byName.openarch_context.execute({}, {});
    expect(value.ok).toBe(true);
    expect(value.initialized).toBe(true);
    expect(value.context.configuration).toBe("available");
    expect(byName.openarch_context.isConcurrencySafe({})).toBe(true);
  });

  it("渲染只挑决策相关事实", () => {
    const text = renderGateText({ ok: true, exitCode: 0, verdict: "PASS", command: "openarch check --worktree --report", report: "body" }, "check");
    expect(text).toContain("PASS");
    expect(text).toContain("openarch check --worktree --report");
    expect(text).toContain("body");
  });
});

describe("openarch-tools: openarch_check / review", () => {
  it("staged 与 worktree 互斥 → 结构化失败，不触达 CLI", async () => {
    const { byName, services } = mount();
    const exec = services.get("openarch.exec").execFile;
    const spy = vi.fn(exec);
    services.set("openarch.exec", { execFile: spy });
    const value = await byName.openarch_check.execute({ staged: true, worktree: true }, {});
    expect(value.ok).toBe(false);
    expect(value.error).toContain("互斥");
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    [0, "PASS"],
    [1, "WARN"],
    [2, "BLOCK"],
    [3, "ERROR"],
  ])("退出码 %i → verdict %s", async (exitCode, verdict) => {
    const { byName } = mount(exitCode);
    const value = await byName.openarch_check.execute({ worktree: true }, {});
    expect(value.ok).toBe(true);
    expect(value.exitCode).toBe(exitCode);
    expect(value.verdict).toBe(verdict);
    expect(value.command).toContain("check");
    expect(value.command).toContain("--report");
  });

  it("review --evolution 传递参数", async () => {
    const { byName, services } = mount();
    const exec = services.get("openarch.exec").execFile;
    const spy = vi.fn(exec);
    services.set("openarch.exec", { execFile: spy });
    const value = await byName.openarch_review.execute({ evolution: true }, {});
    expect(value.ok).toBe(true);
    const args = spy.mock.calls[0][1];
    expect(args).toContain("review");
    expect(args).toContain("--evolution");
  });

  it("CLI 进程级失败 → { ok: false, verdict: ERROR }", async () => {
    const { byName, services } = mount();
    services.set("openarch.exec", {
      execFile: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    const value = await byName.openarch_check.execute({}, {});
    expect(value.ok).toBe(false);
    expect(value.verdict).toBe("ERROR");
    expect(value.error).toContain("spawn ENOENT");
  });

  it("presentResult 用 presentationMeta 里的 verdict 起标题", () => {
    const { byName } = mount();
    const view = byName.openarch_check.presentResult({}, { meta: { verdict: "WARN", exitCode: 1 } });
    expect(view.card).toBe("generic");
    expect(view.title).toContain("WARN");
  });
});

describe("openarch-tools: openarch_scan", () => {
  it("有 jobs 服务 → 后台任务并返回 jobId", async () => {
    const { byName, services } = mount();
    const jobs = { start: vi.fn(() => "openarch-7") };
    services.set("jobs", jobs);
    const value = await byName.openarch_scan.execute({ rebuild: true }, { agent: { id: "a" } });
    expect(value.background).toBe(true);
    expect(value.jobId).toBe("openarch-7");
    expect(jobs.start).toHaveBeenCalledTimes(1);
    const spec = jobs.start.mock.calls[0][0];
    expect(spec.kind).toBe("openarch");
    expect(spec.label).toContain("scan --rebuild");
    expect(spec.owner).toEqual({ id: "a" });
    expect(typeof spec.run).toBe("function");
  });

  it("后台任务生产者：流式输出游标 + close 结算 completed", async () => {
    const { byName, services, spawned } = mount();
    const jobs = { start: vi.fn((spec) => spec) };
    services.set("jobs", jobs);
    await byName.openarch_scan.execute({}, {});
    const hooks = jobs.start.mock.calls[0][0].run();
    expect(typeof hooks.cancel).toBe("function");
    expect(typeof hooks.readOutput).toBe("function");
    spawned.dataHandlers[0]("line one\n");
    expect(hooks.readOutput()).toContain("line one");
    spawned.dataHandlers[0]("line two\n");
    expect(hooks.readOutput()).toContain("line two");
    expect(hooks.readOutput()).toBe("");
    spawned.listeners.get("close")(0);
    const outcome = await hooks.done;
    expect(outcome.status).toBe("completed");
    expect(outcome.detail).toBe("exit code: 0");
    expect(outcome.output).toContain("line two");
  });

  it("后台任务生产者：cancel → kill → 结算 killed", async () => {
    const { byName, services, spawned } = mount();
    const jobs = { start: vi.fn((spec) => spec) };
    services.set("jobs", jobs);
    await byName.openarch_scan.execute({}, {});
    const hooks = jobs.start.mock.calls[0][0].run();
    hooks.cancel("user");
    expect(spawned.child.kill).toHaveBeenCalledTimes(1);
    spawned.listeners.get("close")(1);
    const outcome = await hooks.done;
    expect(outcome.status).toBe("killed");
    expect(outcome.detail).toBe("cancelled");
  });

  it("无 jobs 服务 → 同步执行并映射 verdict", async () => {
    const { byName } = mount(0);
    const value = await byName.openarch_scan.execute({}, {});
    expect(value.background).toBe(false);
    expect(value.ok).toBe(true);
    expect(value.verdict).toBe("PASS");
    expect(value.command).toContain("scan");
  });
});

describe("openarch-tools: openarch_test", () => {
  const testReportFixture = {
    schema: "test-governance-json-v1",
    verdict: "WARN",
    decision: {
      verdict: "WARN",
      findingCount: 2,
      triggered: [{ level: "warn", kind: "missing_assertion", file: "a.test.ts", testName: "x" }],
      exemptedCount: 0,
      errors: [],
    },
    collection: {
      coverage: {
        status: "PARTIAL",
        reasons: ["provider 未配置"],
        testFiles: 4,
        unbaselinedTestFiles: 1,
        providerHandledTestFiles: 3,
        unrecognizedTestFiles: 0,
        failedTestFiles: 0,
      },
      providers: [
        { providerId: "vitest", status: "PARTIAL", reasons: [], candidates: 4, handled: 3, missingBaseline: 1, failed: 0 },
      ],
      testFiles: 4,
      providersRun: ["vitest"],
      summaries: [
        { providerId: "vitest", testFiles: 4, testCases: 9, p95: { loc: 42.5, assertionCount: 3.2, mockCount: 1.0, testBodyControlFlow: 2.1 } },
      ],
      testCaseSpans: { availability: "partial" },
      unrecognizedTestFiles: [],
      suggestedAdapters: { providers: ["vitest"], runners: ["pnpm"] },
      staticModuleAssociations: { testFiles: 4, modules: 3, edges: 5, low: 2, medium: 3 },
      associationUnavailableTestFiles: 0,
    },
    execution: { runnersRun: ["pnpm"], executions: [{ providerId: "vitest", passed: true, command: "pnpm vitest run" }] },
    scripts: { unavailable: [], pruning: [] },
    bloat: { score: 0.42, triggered: false, parts: [] },
  };

  const mountTestTool = ({ initializedDir = null } = {}) => {
    const dir = initializedDir ?? freshTmpDir();
    const { ctx, tools, services } = fakeCtx();
    services.set("openarch.exec", {
      execFile: async (_file, args) => {
        if (args.includes("context")) {
          return {
            stdout: JSON.stringify({
              configuration: "available",
          schema: "context-json-v1",
              baseline: { available: true, files: 10, scope: "compatible", freshness: "fresh" },
              architecturePolicy: { state: "configured", declaredRules: 3 },
              changes: { worktree: { paths: 0, sourcePaths: 0 }, staged: { paths: 0, sourcePaths: 0 } },
            }),
            stderr: "",
          };
        }
        if (args.includes("--list")) {
          return { stdout: JSON.stringify({ schema: "test-governance-provider-list-v1", providers: [{ id: "vitest", label: "Vitest" }] }), stderr: "" };
        }
        if (args.includes("test")) {
          return { stdout: JSON.stringify(testReportFixture), stderr: "" };
        }
        const error = new Error("exit 0");
        error.code = 0;
        error.stdout = "";
        error.stderr = "";
        throw error;
      },
    });
    services.set("openarch.cwd", { value: dir });
    services.set("systemPrompt", { section: vi.fn(() => () => {}) });
    const harness = { handle: vi.fn(() => () => {}) };
    services.set("harness", harness);
    apply(ctx, { openarchBin: "openarch", stateTtlMs: 60_000 });
    const byName = {};
    for (const call of tools.register.mock.calls) byName[call[0].name] = call[0];
    return { byName, harness, dir };
  };

  /** 自定义 execFile 的 openarch_test 挂载（失败面分类用例）。 */
  const mountTestToolWithStdout = (execFile) => {
    const { ctx, tools, services } = fakeCtx();
    services.set("openarch.exec", { execFile });
    services.set("openarch.cwd", { value: freshTmpDir() });
    services.set("systemPrompt", { section: vi.fn(() => () => {}) });
    services.set("harness", { handle: vi.fn(() => () => {}) });
    apply(ctx, { openarchBin: "openarch", stateTtlMs: 60_000 });
    const byName = {};
    for (const call of tools.register.mock.calls) byName[call[0].name] = call[0];
    return { byName };
  };

  it("list 模式解析 provider 列表（test --list --json 契约）", async () => {
    const { byName } = mountTestTool();
    const value = await byName.openarch_test.execute({ list: true }, {});
    expect(value.ok).toBe(true);
    expect(value.list).toBe(true);
    expect(value.providers).toEqual([{ id: "vitest", label: "Vitest" }]);
    expect(value.command).toContain("--list");
  });

  it("评估模式投影 test-governance-json-v1 并把观察写入状态槽", async () => {
    const dir = freshTmpDir();
    mkdirSync(join(dir, ".openarch"), { recursive: true });
    writeFileSync(join(dir, ".openarch", "config.yml"), 'presentation:\n  locale: "zh"\n');
    const { byName, harness } = mountTestTool({ initializedDir: dir });
    const value = await byName.openarch_test.execute({ bloat: true }, {});
    expect(value.ok).toBe(true);
    expect(value.command).toContain("--bloat");
    expect(value.verdict).toBe("PASS"); // CLI exit 0
    expect(value.testGovernance.schema).toBe("test-governance-json-v1");
    expect(value.testGovernance.coverage.testFiles).toBe(4);
    expect(value.testGovernance.decision.findingCount).toBe(2);
    expect(value.testGovernance.providers[0].providerId).toBe("vitest");
    expect(value.testGovernance.suggestedAdapters.providers).toEqual(["vitest"]);
    expect(value.testGovernance.bloat.triggered).toBe(false);
    // dashboard 数据源：下一次状态采集带上最近一次观察。
    const [, handler] = harness.handle.mock.calls[0];
    const state = await handler({});
    expect(state.testGovernance).not.toBeNull();
    expect(state.testGovernance.verdict).toBe("WARN");
    expect(state.testGovernance.coverage.testFiles).toBe(4);
  });

  it("契约解析失败 → 按退出码分类 error 并保留原始报告", async () => {
    // exit 0 且非 JSON → 契约漂移面。
    const drift = mountTestToolWithStdout(async () => ({ stdout: "not-json-at-all", stderr: "" }));
    const driftValue = await drift.byName.openarch_test.execute({}, {});
    expect(driftValue.ok).toBe(true);
    expect(driftValue.testGovernance).toBeUndefined();
    expect(driftValue.error).toContain("不是合法 JSON");
    expect(driftValue.error).toContain("契约漂移");
    expect(driftValue.report).toContain("not-json-at-all");
    // exit 3 + 文本（旧二进制"未知命令"）→ 版本过旧面。
    const outdated = mountTestToolWithStdout(async () => {
      const error = new Error("exit 3");
      error.code = 3;
      error.stdout = "未知命令: test。运行 openarch --help 查看用法。";
      error.stderr = "";
      throw error;
    });
    const outdatedValue = await outdated.byName.openarch_test.execute({}, {});
    expect(outdatedValue.ok).toBe(true);
    expect(outdatedValue.verdict).toBe("ERROR");
    expect(outdatedValue.error).toContain("版本过旧");
    expect(outdatedValue.error).toContain("升级/重装");
    expect(outdatedValue.report).toContain("未知命令");
    // list 模式同分类。
    const listValue = await drift.byName.openarch_test.execute({ list: true }, {});
    expect(listValue.ok).toBe(true);
    expect(listValue.error).toContain("不是合法 JSON");
  });

  it("契约 schema 不识别 → fail-closed 不静默解析（上游契约纪律）", async () => {
    // 评估模式：schema 被 bump 到 v2（本插件只认识 v1）。
    const v2 = mountTestToolWithStdout(async () => ({
      stdout: JSON.stringify({ ...testReportFixture, schema: "test-governance-json-v2" }),
      stderr: "",
    }));
    const value = await v2.byName.openarch_test.execute({}, {});
    expect(value.ok).toBe(true);
    expect(value.testGovernance).toBeUndefined();
    expect(value.error).toContain("契约版本不识别");
    expect(value.error).toContain("test-governance-json-v1");
    expect(value.error).toContain("fail-closed");
    // list 模式：provider-list schema 缺失/漂移同样拒绝。
    const listBad = mountTestToolWithStdout(async () => ({
      stdout: JSON.stringify({ schema: "test-governance-provider-list-v9", providers: [{ id: "x", label: "X" }] }),
      stderr: "",
    }));
    const listValue = await listBad.byName.openarch_test.execute({ list: true }, {});
    expect(listValue.ok).toBe(true);
    expect(listValue.providers).toBeUndefined();
    expect(listValue.error).toContain("契约版本不识别");
  });

  it("renderTestText 渲染 list/评估/失败三面（表格与 CLI 同观感）", () => {
    const listText = renderTestText({ ok: true, exitCode: 0, verdict: "PASS", list: true, providers: [{ id: "vitest", label: "Vitest" }] });
    expect(listText).toContain("Vitest");
    const evalText = renderTestText({
      ok: true, exitCode: 1, verdict: "WARN", command: "openarch test --json",
      testGovernance: {
        verdict: "WARN",
        coverage: { status: "PARTIAL", reasons: ["provider 未配置"], testFiles: 4, providerHandledTestFiles: 3, unbaselinedTestFiles: 1, unrecognizedTestFiles: 0, failedTestFiles: 0 },
        providers: [{ providerId: "vitest", status: "PARTIAL", candidates: 4, handled: 3, missingBaseline: 1, failed: 0 }],
        summaries: [{ providerId: "vitest", testFiles: 4, testCases: 9, p95: { loc: 42.5, assertionCount: 3.2, mockCount: 1.0 } }],
        suggestedAdapters: { providers: ["vitest"], runners: ["pnpm"] },
        bloat: { score: 0.42, triggered: true },
        decision: { findingCount: 2, triggered: [{ level: "warn", kind: "missing_assertion" }], errors: [] },
      },
      report: "",
    });
    expect(evalText).toContain("覆盖状态: PARTIAL");
    expect(evalText).toContain("Provider 覆盖:");
    expect(evalText).toContain("vitest");
    expect(evalText).toContain("TEST_BLOAT");
    expect(evalText).toContain("只读观察");
    expect(evalText).toContain("触发 warn:missing_assertion");
    const failText = renderTestText({ ok: false, error: "spawn 失败" });
    expect(failText).toContain("openarch test 失败");
  });
});

describe("openarch-tools: openarch_contract", () => {
  const contractFixture = {
    schema: "contract-catalog-json-v1",
    openarchVersion: "0.1.2",
    contracts: [
      { id: "context-json", version: "context-json-v1", status: "current", summary: "…" },
      { id: "test-governance-json", version: "test-governance-json-v1", status: "current", summary: "…" },
      { id: "test-governance-provider-list-json", version: "test-governance-provider-list-v1", status: "current", summary: "…" },
    ],
  };

  const mountContractTool = (execFile) => {
    const { ctx, tools, services } = fakeCtx();
    services.set("openarch.exec", { execFile });
    services.set("openarch.cwd", { value: freshTmpDir() });
    services.set("systemPrompt", { section: vi.fn(() => () => {}) });
    services.set("harness", { handle: vi.fn(() => () => {}) });
    apply(ctx, { openarchBin: "openarch", stateTtlMs: 60_000 });
    const byName = {};
    for (const call of tools.register.mock.calls) byName[call[0].name] = call[0];
    return { byName };
  };

  it("解析契约目录投影（contract --json，contract-catalog-json-v1）", async () => {
    const { byName } = mountContractTool(async () => ({ stdout: JSON.stringify(contractFixture), stderr: "" }));
    const value = await byName.openarch_contract.execute({}, {});
    expect(value.ok).toBe(true);
    expect(value.verdict).toBe("PASS");
    expect(value.catalog.openarchVersion).toBe("0.1.2");
    expect(value.catalog.contracts).toHaveLength(3);
    expect(value.catalog.contracts[0].id).toBe("context-json");
    expect(byName.openarch_contract.isConcurrencySafe({})).toBe(true);
  });

  it("旧二进制（未知命令）→ 版本过旧分类", async () => {
    const { byName } = mountContractTool(async () => {
      const error = new Error("exit 3");
      error.code = 3;
      error.stdout = "未知命令: contract。运行 openarch --help 查看用法。";
      error.stderr = "";
      throw error;
    });
    const value = await byName.openarch_contract.execute({}, {});
    expect(value.ok).toBe(true);
    expect(value.catalog).toBeUndefined();
    expect(value.error).toContain("版本过旧");
    expect(value.report).toContain("未知命令");
  });

  it("目录 schema 不识别 → fail-closed 不静默解析", async () => {
    const { byName } = mountContractTool(async () => ({
      stdout: JSON.stringify({ ...contractFixture, schema: "contract-catalog-json-v9" }),
      stderr: "",
    }));
    const value = await byName.openarch_contract.execute({}, {});
    expect(value.ok).toBe(true);
    expect(value.catalog).toBeUndefined();
    expect(value.error).toContain("fail-closed");
    expect(value.error).toContain("contract-catalog-json-v1");
  });

  it("renderContractText 渲染目录/失败两面", () => {
    const text = renderContractText({
      ok: true, exitCode: 0, verdict: "PASS",
      catalog: {
        openarchVersion: "0.1.2",
        contracts: [
          { id: "context-json", version: "context-json-v1", status: "current" },
          { id: "test-governance-json", version: "test-governance-json-v1", status: "current" },
        ],
      },
    });
    expect(text).toContain("openarch 版本: 0.1.2");
    expect(text).toContain("context-json: context-json-v1");
    expect(text).toContain("fail-closed");
    const failText = renderContractText({ ok: false, error: "spawn 失败" });
    expect(failText).toContain("openarch contract 失败");
  });
});

describe("openarch-tools: 多工作区定位", () => {
  it("sessionCwdOf 优先 exec 会话 cwd，回退行配置", () => {
    const options = { cwd: "C:/default" };
    expect(sessionCwdOf(undefined, options)).toBe("C:/default");
    expect(sessionCwdOf({ agent: { session: { cwd: "C:/sess" } } }, options)).toBe("C:/sess");
    expect(sessionCwdOf({ agent: { session: { header: { cwd: "C:/header" }, cwd: "C:/sess" } } }, options)).toBe("C:/header");
  });

  it("数据通道 root 参数白名单校验：已知工作区按 root 服务，未知 root fail-closed", async () => {
    const workspace = freshTmpDir();
    mkdirSync(join(workspace, ".openarch"), { recursive: true });
    writeFileSync(join(workspace, ".openarch", "config.yml"), 'presentation:\n  locale: "zh"\n');
    const { ctx, services } = fakeCtx();
    services.set("openarch.exec", {
      execFile: async (_file, args) => {
        if (args.includes("contract")) {
          return { stdout: JSON.stringify({ schema: "contract-catalog-json-v1", openarchVersion: "0.1.2", contracts: [] }), stderr: "" };
        }
        return {
          stdout: JSON.stringify({
            configuration: "available",
            schema: "context-json-v1",
            baseline: { available: true, files: 10, scope: "compatible", freshness: "fresh" },
            architecturePolicy: { state: "configured", declaredRules: 3 },
            changes: { worktree: { paths: 0, sourcePaths: 0 }, staged: { paths: 0, sourcePaths: 0 } },
          }),
          stderr: "",
        };
      },
    });
    services.set("openarch.cwd", { value: freshTmpDir() });
    services.set("workspaceRegistry", { list: () => [{ path: workspace }] });
    services.set("systemPrompt", { section: vi.fn(() => () => {}) });
    const harness = { handle: vi.fn(() => () => {}) };
    services.set("harness", harness);
    apply(ctx, { openarchBin: "openarch", stateTtlMs: 60_000 });
    const [, handler] = harness.handle.mock.calls[0];
    const state = await handler({ root: workspace });
    expect(state.root).toBe(workspace);
    expect(state.initialized).toBe(true);
    await expect(handler({ root: freshTmpDir() })).rejects.toThrow(/unknown workspace root/);
  });
});

describe("openarch-tools: 客户端数据通道", () => {
  it("harness.handle 注册 governance-state，handler 返回有界状态快照", async () => {
    const { harness } = mount();
    expect(harness.handle).toHaveBeenCalledTimes(1);
    const [method, handler] = harness.handle.mock.calls[0];
    expect(method).toBe("openarch/governance-state");
    const state = await handler({});
    // cwd 是临时空目录 → 未初始化，fail-closed 且不跑 CLI
    expect(state.initialized).toBe(false);
  });

  it("force 参数绕过 TTL 强制重采（刷新按钮语义）", async () => {
    const dir = freshTmpDir();
    mkdirSync(join(dir, ".openarch"), { recursive: true });
    writeFileSync(join(dir, ".openarch", "config.yml"), 'presentation:\n  locale: "zh"\nlanguages: ["typescript"]\n');
    const { ctx, services } = fakeCtx();
    let contextCalls = 0;
    services.set("openarch.exec", {
      execFile: async (file, args) => {
        if (args.includes("context")) {
          contextCalls += 1;
          return {
            stdout: JSON.stringify({
              configuration: "available",
          schema: "context-json-v1",
              baseline: { available: true, files: 10, scope: "compatible", freshness: "fresh", scanAt: "2026-08-11T00:00:00Z" },
              architecturePolicy: { state: "configured", declaredRules: 3 },
              changes: { worktree: { paths: 2, sourcePaths: 1 }, staged: { paths: 0, sourcePaths: 0 } },
            }),
            stderr: "",
          };
        }
        const error = new Error("exit 0");
        error.code = 0;
        error.stdout = "";
        error.stderr = "";
        throw error;
      },
    });
    services.set("openarch.cwd", { value: dir });
    services.set("systemPrompt", { section: vi.fn(() => () => {}) });
    const harness = { handle: vi.fn(() => () => {}) };
    services.set("harness", harness);
    apply(ctx, { openarchBin: "openarch", stateTtlMs: 60_000 });
    const [, handler] = harness.handle.mock.calls[0];
    await handler({});
    await handler({});
    // TTL 内重复读取复用快照，CLI 只跑一次。
    expect(contextCalls).toBe(1);
    await handler({ force: true });
    // force 绕过 TTL → 重新采集。
    expect(contextCalls).toBe(2);
  });

  it("无 harness 与 webServer 时静默跳过（不抛异常）", () => {
    const { ctx, tools } = fakeCtx();
    const services = new Map();
    const bare = {
      get: (key) => services.get(key),
      effect: () => {},
      tools,
    };
    void ctx;
    expect(() => apply(bare, { cwd: freshTmpDir() })).not.toThrow();
  });
});
