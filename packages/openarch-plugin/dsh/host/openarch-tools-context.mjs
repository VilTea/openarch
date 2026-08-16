/**
 * OpenArch DSH 插件 — openarch_context 工具构造器（Host）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadCliContext } from "./openarch-state.mjs";
import { execSeamOf, sessionCwdOf } from "./openarch-tools-run.mjs";
import { renderContextText } from "./openarch-tools-render.mjs";

/** openarch_context：只读项目事实（context --json 契约，秒级）。 */
export function buildContextTool(deps) {
  const { ctx, options } = deps;
  return {
    name: "openarch_context",
    description: "读取 OpenArch 项目治理事实（配置、baseline 状态、变更计数、就绪状态）。只读、秒级；输出为稳定 JSON 契约的摘要。",
    parameters: {},
    isConcurrencySafe: () => true,
    timeoutMs: 60_000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: {
          ok: { type: "boolean" },
          initialized: { type: "boolean" },
          root: { type: "string" },
          context: { type: "object", additionalProperties: true },
          error: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderContextText(value) }],
    },
    execute: async (_args, exec) => {
      // 会话工作区优先：多项目并存时每个会话读自己的项目事实。
      const cwd = sessionCwdOf(exec, options);
      const cli = await loadCliContext({ ...options, execFileAsync: execSeamOf(ctx).execFile, cwd });
      const initialized = cli.ok || existsSync(join(cwd, ".openarch", "config.yml"));
      return {
        ok: cli.ok,
        initialized,
        root: cwd,
        ...(cli.ok ? { context: cli.context } : { error: cli.error }),
      };
    },
    presentCall: () => ({ card: "generic", title: "OpenArch 治理上下文", kind: "read", rawInput: "openarch context --json" }),
  };
}
