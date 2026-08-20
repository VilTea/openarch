/**
 * OpenArch DSH 插件 — openarch_check / openarch_review 工具构造器（Host）。
 */
import { runCli, sessionCwdOf, tailChars, verdictOf } from "./openarch-tools-run.mjs";
import { renderGateText } from "./openarch-tools-render.mjs";

/** check/review/scan 共用的 canonical 输出 schema。 */
export const GATE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    exitCode: { type: "integer" },
    verdict: { type: "string", enum: ["PASS", "WARN", "BLOCK", "ERROR"] },
    command: { type: "string" },
    report: { type: "string" },
    stderr: { type: "string" },
    error: { type: "string" },
  },
};

/** 组装一次 gate 类命令的参数（check/review 有各自的可选旗标）。 */
function gateArgs(kind, args) {
  const { staged = false, worktree = false, tests = false, evolution = false } = args ?? {};
  const commandArgs = [kind];
  if (kind === "check") {
    commandArgs.push(staged ? "--staged" : "--worktree");
    if (tests) commandArgs.push("--tests");
    commandArgs.push("--report");
  } else if (evolution) {
    commandArgs.push("--evolution");
  }
  return commandArgs;
}

/**
 * openarch_check / openarch_review 共用构造器。
 * 执行结果映射：0 PASS · 1 WARN · 2 BLOCK · 3/信号 ERROR（与 CLI 契约一致）。
 */
export function buildGateTool(deps, kind, description, argFlags, callTitle) {
  const { ctx, options, caches } = deps;
  return {
    name: `openarch_${kind}`,
    description,
    parameters: {
      type: "object",
      properties: argFlags.reduce((acc, flag) => {
        acc[flag.key] = { type: "boolean", description: flag.description };
        return acc;
      }, {}),
    },
    isConcurrencySafe: () => false,
    timeoutMs: 300_000,
    output: {
      schema: GATE_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: renderGateText(value, kind) }],
      presentationMeta: (_args, value) => ({ verdict: value.verdict, exitCode: value.exitCode }),
    },
    execute: async (args, exec) => {
      if (args?.staged && args?.worktree) {
        return { ok: false, verdict: "ERROR", error: "staged 与 worktree 互斥" };
      }
      const cwd = sessionCwdOf(exec, options);
      const commandArgs = gateArgs(kind, args);
      const result = await runCli(ctx, options, commandArgs, 300_000, cwd);
      caches.invalidate(cwd);
      if (!result.ok) {
        return { ok: false, verdict: "ERROR", error: result.error, command: [options.openarchBin, ...commandArgs].join(" ") };
      }
      return {
        ok: true,
        exitCode: result.exitCode,
        verdict: verdictOf(result.exitCode),
        command: [options.openarchBin, ...commandArgs].join(" "),
        report: tailChars(result.stdout, 16_000),
        stderr: tailChars(result.stderr, 2_000),
      };
    },
    presentCall: (args) => ({
      card: "generic",
      title: callTitle(args),
      kind: "execute",
      rawInput: args && Object.keys(args).some((key) => args[key]) ? args : undefined,
    }),
    presentResult: (_args, result) => ({
      card: "generic",
      title: result.meta?.verdict
        ? `OpenArch ${kind}：${result.meta.verdict}（exit ${result.meta.exitCode}）`
        : `OpenArch ${kind} 结果`,
    }),
  };
}
