/**
 * OpenArch DSH 插件 — 模型工具层入口（Host）。
 *
 * 把 openarch CLI 的命令面注册为一级模型工具：
 * - openarch_context  只读项目事实（context --json 契约，秒级）
 * - openarch_check    统一变更验证（worktree/staged + gate/策略/反模式报告）
 * - openarch_review   架构门禁复查（含 WARN 触发明细）
 * - openarch_scan     重建/更新基线（优先作为后台任务运行，可收集、可取消）
 * - openarch_test     测试治理评估（只读观察：覆盖/建议/TEST_BLOAT）
 * - openarch_contract 上游机器契约目录（各可消费 JSON 契约的当前版本）
 *
 * 多工作区口径：每个工作区根目录一份独立状态缓存（createGovernanceCaches）；
 * 工具执行优先按会话 cwd（exec.agent.session.header.cwd）定位项目，数据通道
 * 接受 root 参数并做 workspaceRegistry 白名单校验（防任意路径读取）。
 *
 * 模块职责：执行细节在 openarch-tools-run.mjs（子进程/后台任务生产者），
 * 渲染在 openarch-tools-render.mjs，各工具构造器在
 * openarch-tools-{context,gate,scan,test,contract}.mjs，治理状态读取在
 * openarch-state.mjs，上游契约版本认识在 openarch-contracts.mjs。
 *
 * 客户端数据通道（同一份有界状态快照）：
 * - 动态包：harness.handle("openarch/governance-state", { root, force })
 * - 静态挂载：webServer 路由 GET /api/openarch/governance-state?root=<path>&force=1
 */
import { createGovernanceCaches, normalizeRoot } from "./openarch-state.mjs";
import { cwdSeamOf, execSeamOf, pickConfig } from "./openarch-tools-run.mjs";
import { buildContextTool } from "./openarch-tools-context.mjs";
import { buildGateTool } from "./openarch-tools-gate.mjs";
import { buildScanTool } from "./openarch-tools-scan.mjs";
import { buildTestTool } from "./openarch-tools-test.mjs";
import { buildContractTool } from "./openarch-tools-contract.mjs";

export { verdictOf, tailChars, sessionCwdOf } from "./openarch-tools-run.mjs";
export { renderContextText, renderGateText, renderTestText, renderContractText } from "./openarch-tools-render.mjs";

export const name = "openarch-tools";

/** `ctx.tools` 是硬依赖：没有工具注册表这个插件毫无意义。 */
export const inject = ["tools"];

const TOOL_GUIDANCE = {
  name: "tool:openarch",
  order: 108,
  text: "OpenArch 工具纪律：先 openarch_context 建立事实，再按需 openarch_check/openarch_review；openarch_scan 是后台任务，用 job_output 收集。check 报告是全量信号面：PASS 只表示已声明策略未触发，仍需读完 WARN/反模式/信号；PARTIAL/UNAVAILABLE 是事实边界，处理或记录，不得伪装成 clean。P95 对小样本策略不稳定，阈值仅作观察，不建议据此新增 BLOCK。openarch_test 是只读治理观察：适配器建议需用户显式写入 config.yml，绝不自动启用 provider 或据此新增 BLOCK。openarch_contract 读取上游机器契约目录；对未知契约版本一律 fail-closed，不静默解析。",
};

/**
 * 工作区白名单解析：root 参数必须命中 workspaceRegistry 已注册的路径
 * （大小写不敏感、分隔符归一），否则 fail-closed；无参数时回退行配置 cwd。
 * @returns 命中的规范化工作区路径，或 null（未知 root，调用方拒绝）。
 */
function resolveRoot(ctx, options, rootParam) {
  const registry = ctx.get("workspaceRegistry");
  const paths = [];
  if (registry && typeof registry.list === "function") {
    for (const w of registry.list()) {
      if (typeof w?.path === "string" && w.path.length > 0) paths.push(w.path);
    }
  }
  const requested = typeof rootParam === "string" && rootParam.length > 0 ? rootParam : null;
  if (requested === null) return options.cwd;
  const key = normalizeRoot(requested);
  const match = paths.find((p) => normalizeRoot(p) === key);
  return match === undefined ? null : match;
}

/** 统一数据通道处理器：按 root 定位缓存；force 绕过 TTL 强制重采。 */
async function serveGovernanceState(caches, ctx, options, rootParam, force) {
  const root = resolveRoot(ctx, options, rootParam);
  if (root === null) {
    const error = new Error(`openarch: unknown workspace root "${rootParam}"（不在 workspaceRegistry 白名单，fail-closed）`);
    error.code = "UNKNOWN_ROOT";
    throw error;
  }
  const cache = caches.forRoot(root);
  if (force) cache.invalidate();
  return await cache.get();
}

const parseQuery = (url) => {
  try {
    return new URLSearchParams(String(url ?? "").split("?")[1] ?? "");
  } catch {
    return new URLSearchParams();
  }
};

/** 注册客户端数据通道：动态 RPC + 静态 HTTP 路由（都支持 root/force）。 */
function registerGovernanceRpc(ctx, caches, options) {
  ctx.effect(() => {
    const disposers = [];
    const harness = (typeof globalThis !== "undefined" && globalThis.harness) ?? ctx.get("harness");
    if (harness && typeof harness.handle === "function") {
      disposers.push(harness.handle("openarch/governance-state", (args) =>
        serveGovernanceState(caches, ctx, options, args?.root, args?.force === true)));
    }
    const web = ctx.get("webServer");
    if (web && typeof web.register === "function") {
      disposers.push(web.register({
        kind: "exact",
        path: "/api/openarch/governance-state",
        handler: async (req, res) => {
          try {
            const query = parseQuery(req?.url);
            const state = await serveGovernanceState(caches, ctx, options, query.get("root"), query.get("force") === "1");
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(state));
          } catch (error) {
            if (error?.code === "UNKNOWN_ROOT") {
              res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: String(error.message) }));
            } else {
              res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: String(error && error.message ? error.message : error) }));
            }
          }
        },
      }));
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // 释放失败不阻塞 stop。
        }
      }
    };
  });
}

export function apply(ctx, config) {
  const options = pickConfig(config);
  options.cwd = cwdSeamOf(ctx, options.cwd);
  // openarch_test 观察槽：按 root 各持最近一次评估投影（多工作区隔离）。
  const lastTestByRoot = new Map();
  const caches = createGovernanceCaches({
    ...options,
    execFileAsync: execSeamOf(ctx).execFile,
    testGovernanceReader: (root) => lastTestByRoot.get(normalizeRoot(root)) ?? null,
  });
  const deps = {
    ctx,
    options,
    caches,
    cacheFor: (cwd) => caches.forRoot(cwd) ?? caches.forRoot(options.cwd),
    onTestGovernance: (value, root) => {
      lastTestByRoot.set(normalizeRoot(root), value);
    },
  };

  registerGovernanceRpc(ctx, caches, options);

  const systemPrompt = ctx.get("systemPrompt");
  if (systemPrompt && typeof systemPrompt.section === "function") {
    systemPrompt.section(TOOL_GUIDANCE);
  }

  ctx.tools.register(buildContextTool(deps));
  ctx.tools.register(buildGateTool(
    deps,
    "check",
    "运行 OpenArch 统一变更验证：对工作树或已暂存改动执行 gate/策略/反模式检查并输出报告。退出码 0 PASS / 1 WARN / 2 BLOCK / 3 错误；报告是全量信号面，PASS 仍需逐项消费。",
    [
      { key: "worktree", description: "验证工作树未暂存改动（默认）。" },
      { key: "staged", description: "验证已暂存改动（与 worktree 互斥）。" },
      { key: "tests", description: "同时运行测试治理证据（更慢）。" },
    ],
    (args) => (args?.staged ? "OpenArch 校验已暂存改动" : "OpenArch 校验工作树改动"),
  ));
  ctx.tools.register(buildGateTool(
    deps,
    "review",
    "运行 OpenArch 架构门禁复查：输出结构候选 Top-3 与 WARN 触发明细（规则 + 条件 + 触发文件），用于反复修改后的架构检查。",
    [{ key: "evolution", description: "追加演化证据视角（历史趋势）。" }],
    (args) => (args?.evolution ? "OpenArch 架构复查（演化视角）" : "OpenArch 架构复查"),
  ));
  ctx.tools.register(buildScanTool(deps));
  ctx.tools.register(buildTestTool(deps));
  ctx.tools.register(buildContractTool(deps));
}
