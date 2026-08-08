// packages/cli/src/commands/lsp.ts
// `openarch lsp` command family: daemon lifecycle for long-lived LSP processes
// (jdtls forwarding daemon). Hook 生命周期：SessionStart 调 start、Stop 调 stop。
import spawn from "cross-spawn";
import { writeFileSync, mkdirSync, accessSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import type { CommandHandler } from "../runtime";
import { jdtlsDaemonPort, jdtlsDataDir, jdtlsDaemonStatus, stopJdtlsDaemon } from "@openarch/core";
import { discoverSemanticToolchains, nodeToolchainRuntime, readProjectLanguageState, type ProjectLanguageState } from "@openarch/core";

const usage = "用法: openarch lsp <start|stop|status> [--lang java]";

/** `lsp start` 的决策结果（纯函数，便于单测——门禁/提醒/fail-soft 分支）。 */
export interface LspStartPlan {
  readonly outcome: "unsupported-lang" | "skip-lang" | "already-running" | "skip-toolchain" | "start";
  readonly message: string;
  /** 非阻塞引导信号（如"已初始化但未声明 languages"），调用方统一打印 */
  readonly reminder?: string;
  readonly exit: 0 | 3;
}

/** 语言门禁与工具链就绪的纯决策：命令层只收集输入（状态/检测），不内嵌分支。
 *  未来预热第二语言时在此扩展 outcome（如 rust 的 daemon 策略），命令层不动。 */
export const planLspStart = (input: {
  readonly lang: string;
  readonly languageState: ProjectLanguageState;
  readonly daemonRunning: boolean;
  readonly launchAvailable: boolean;
  readonly owner: string;
}): LspStartPlan => {
  if (input.lang !== "java") {
    return { outcome: "unsupported-lang", message: `openarch lsp：暂不支持 --lang ${input.lang}（当前仅 java 转发 daemon）`, exit: 3 };
  }
  const { configured, detected, configExists } = input.languageState;
  const projectLanguages = configured && configured.length > 0 ? configured : detected;
  let reminder: string | undefined;
  if (configExists && !(configured && configured.length > 0)) {
    const detectedText = detected.length > 0 ? detected.join(", ") : "无";
    reminder = `项目已初始化但 config.yml 未声明 languages（检测到: ${detectedText}）——建议在 config.yml 配置 languages 以稳定 LSP 预热行为`;
  }
  if (!projectLanguages.includes("java")) {
    const detectedText = projectLanguages.length > 0 ? projectLanguages.join(", ") : "无";
    return { outcome: "skip-lang", message: `openarch lsp: 项目未使用 java（检测到: ${detectedText}），跳过 jdtls daemon`, exit: 0, reminder };
  }
  if (input.daemonRunning) {
    return { outcome: "already-running", message: "openarch lsp: jdtls daemon 已在运行", exit: 0, reminder };
  }
  if (!input.launchAvailable) {
    if (input.owner !== "manual") {
      // harness（SessionStart hook）环境 fail-soft：工具链缺失跳过，不中断会话；
      // 手动执行仍 fail-closed（exit 3）明确报错。
      return { outcome: "skip-toolchain", message: `openarch lsp: 未配置 jdtls 工具链（toolchains.yml），harness(${input.owner}) 环境跳过——请配置后重试`, exit: 0, reminder };
    }
    return { outcome: "skip-toolchain", message: "openarch lsp：未配置 jdtls 工具链（toolchains.yml）", exit: 3, reminder };
  }
  return { outcome: "start", message: "", exit: 0, reminder };
};

/** 调用者 harness 标识（多 harness 并发时 owner 引用计数用，校准 2026-08-07）。 */
const detectHarness = (): string => {
  const env = process.env;
  if (env.REASONIX_SESSION || env.REASONIX_HOME) return "reasonix";
  if (env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_PROJECT_DIR) return "claude";
  if (env.OPENCODE_CONFIG || env.OPENCODE_HOME) return "opencode";
  if (env.CODEX_HOME || env.CODEX_API_KEY) return "codex";
  return "manual";
};

const here = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);

/** jdtls 启动配置：复用 core 工具链发现（与 check 同源）+ 稳定 -data（与 fallback 一致）。 */
const jdtlsLaunchFor = (cwd: string): { command: string; args: string[] } | undefined => {
  const report = discoverSemanticToolchains(cwd, ["java"], nodeToolchainRuntime)[0];
  const executable = report?.tools.find((tool) => tool.id === "jdtls")?.executable;
  if (!executable) return undefined;
  const args = ["-data", jdtlsDataDir(cwd)];
  return executable.toLowerCase().endsWith(".bat")
    ? { command: process.env.OPENARCH_PYTHON ?? "python", args: [executable.replace(/\.bat$/i, ""), ...args] }
    : { command: executable, args };
};

/** daemon 独立进程入口（core 的 TS 源——经 tsx 运行，与 CLI 同构）。 */
const daemonEntry = (): string => {
  const candidates = [
    join(here, "../../../../core/src/adapter/symbol-use/jdtlsDaemonEntry.ts"),
    join(here, "../core/dist/adapter/symbol-use/jdtlsDaemonEntry.js"),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate);
      return candidate;
    } catch { /* next */ }
  }
  throw new Error("jdtlsDaemonEntry 未找到");
};

/** tsx 可执行（node <tsx-cli> <entry> ——detached daemon 进程）。 */
const tsxCli = (): string => {
  try {
    // tsx 的 exports 暴露 "./cli"（bin 同款 dist/cli.mjs）——pnpm hoisted 解析到根
    const resolved = require.resolve("tsx/cli");
    accessSync(resolved);
    return resolved;
  } catch {
    return "tsx"; // PATH 兜底（打包发行态——node_modules/.bin/tsx.CMD）
  }
};

const startAction: CommandHandler = async (args, context) => {
  const lang = args.includes("--lang") ? args[args.indexOf("--lang") + 1] ?? "java" : "java";
  // 纯决策（planLspStart 单测覆盖）：命令层只收集输入并执行结果
  const plan = planLspStart({
    lang,
    languageState: readProjectLanguageState(context.cwd),
    daemonRunning: jdtlsDaemonStatus(context.cwd).running,
    launchAvailable: jdtlsLaunchFor(context.cwd) !== undefined,
    owner: detectHarness(),
  });
  if (plan.reminder) console.log(`openarch lsp: ${plan.reminder}`);
  if (plan.outcome !== "start") {
    if (plan.message) console.error(plan.message);
    return plan.exit;
  }
  const port = jdtlsDaemonPort(context.cwd);
  const owner = detectHarness();
  const stateFile = join(tmpdir(), "openarch-lsp", `jdtls-${port}.json`);
  mkdirSync(join(tmpdir(), "openarch-lsp"), { recursive: true });
  const logFile = join(tmpdir(), "openarch-lsp", `jdtls-${port}.log`);
  const logStream = openSync(logFile, "a");
  // plan 已确认 launchAvailable——start 分支重新获取 launch（决策层不携带进程规格）
  const launch = jdtlsLaunchFor(context.cwd)!;
  const child = spawn(process.execPath, [tsxCli(), daemonEntry(), "--cwd", context.cwd, "--launch", JSON.stringify(launch)], {
    cwd: context.cwd,
    detached: true,
    // stderr 写日志（诊断 daemon/jdtls 死亡）；stdout ignore（pipe 断开 EPIPE）
    stdio: ["ignore", "ignore", logStream],
    windowsHide: true,
  });
  child.on("error", (error) => console.error(`openarch lsp: daemon 启动失败: ${error.message}（日志: ${logFile}）`));
  child.unref();
  writeFileSync(stateFile, JSON.stringify({ pid: child.pid, port, cwd: context.cwd, startedAt: new Date().toISOString() }), "utf8");
  console.log(`openarch lsp: jdtls daemon 已启动（pid=${child.pid} port=${port}）`);
  return 0;
};

const stopAction: CommandHandler = async (_args, context) => {
  const stopped = stopJdtlsDaemon(context.cwd, detectHarness());
  if (!stopped) {
    // 引用计数语义：可能已移除 owner 但其他 harness 仍持有，或本就未运行
    const status = jdtlsDaemonStatus(context.cwd);
    if (status.running) {
      console.log("openarch lsp: 已移除当前 harness 的持有，daemon 仍被其他 harness 使用");
    } else {
      console.log("openarch lsp: 无运行中的 jdtls daemon");
    }
    return 0;
  }
  console.log("openarch lsp: jdtls daemon 已停止");
  return 0;
};

const statusAction: CommandHandler = async (_args, context) => {
  const status = jdtlsDaemonStatus(context.cwd);
  if (!status.running) {
    console.log("openarch lsp: jdtls daemon 未运行");
    return 0;
  }
  const state = status.state;
  console.log(`openarch lsp: jdtls daemon 运行中（pid=${state?.pid} port=${state?.port} started=${state?.startedAt}）`);
  return 0;
};

const actionHandlers: Readonly<Record<string, CommandHandler | undefined>> = {
  start: startAction,
  stop: stopAction,
  status: statusAction,
};

export const lspCommand: CommandHandler = async (args, context) => {
  const action = args[0] ?? "";
  const handler = actionHandlers[action];
  if (!handler) {
    console.error(usage);
    return 3;
  }
  return handler(args.slice(1), context);
};
