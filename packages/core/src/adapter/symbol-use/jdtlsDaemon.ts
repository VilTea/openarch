import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { LspLaunchSpec } from "../lsp/NodeLspSession";
import { toPosixPath } from "../../infra/paths";

/**
 * 通用 LSP 转发 daemon（jdtls 校准 2026-08-06；gopls 复用 2026-08-16）。
 *
 * jdtls 无服务端监听模式（CLIENT_PORT 是单向客户端连接），且每会话冷启动
 * 360s（JVM + Maven 导入）；gopls 冷启动同样让大 workspace 的逐文件语义
 * 请求超过集成预算。实测 jdtls 同一 stdio 进程接受重复 initialize，转发
 * daemon 内核因此通用：长驻 stdio LSP server + tcp server + 双向 pipe +
 * exit/shutdown 拦截 + 连接异常容忍。连接断开时保持 LSP 进程存活（stdin
 * 不 EOF），下一会话复用进程与索引。每种语言使用独立端口段前缀与状态文件。
 */

export type LspDaemonKind = "jdtls" | "gopls";

export interface LspDaemonState {
  readonly pid: number;
  readonly port: number;
  readonly cwd: string;
  readonly startedAt: string;
  /** 引用计数（多 harness 并发时的 stop 竞争保护，校准 2026-08-07）。 */
  readonly owners?: readonly string[];
}

/** 项目绑定的 daemon 端口（40000-49999，按 kind+cwd hash 稳定分配）。 */
export const lspDaemonPort = (cwd: string, kind: LspDaemonKind): number => {
  const hash = createHash("sha256").update(`${kind}:${toPosixPath(cwd)}`).digest("hex").slice(0, 6);
  return 40000 + (parseInt(hash, 16) % 10000);
};

export const jdtlsDaemonPort = (cwd: string): number => lspDaemonPort(cwd, "jdtls");
export const goplsDaemonPort = (cwd: string): number => lspDaemonPort(cwd, "gopls");

/** daemon 状态文件（记录 LSP 子进程 PID + 端口——hook Stop 用它关闭）。 */
export const lspDaemonStateFile = (cwd: string, kind: LspDaemonKind): string =>
  join(tmpdir(), "openarch-lsp", `${kind}-${lspDaemonPort(cwd, kind)}.json`);

export const jdtlsDaemonStateFile = (cwd: string): string => lspDaemonStateFile(cwd, "jdtls");
export const goplsDaemonStateFile = (cwd: string): string => lspDaemonStateFile(cwd, "gopls");

/** exit/shutdown 通知（LSP 会话结束信号）——不转发给 server，保持进程存活。 */
const SESSION_END_PATTERN = /"method"\s*:\s*"(?:shutdown|exit)"/;

const writeState = (file: string, state: LspDaemonState): void => {
  mkdirSync(join(tmpdir(), "openarch-lsp"), { recursive: true });
  writeFileSync(file, JSON.stringify(state), "utf8");
};

const readState = (file: string): LspDaemonState | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as LspDaemonState;
  } catch {
    return undefined;
  }
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 把 socket 数据转发到 LSP stdin，拦截 LSP exit/shutdown（保持进程）。 */
const forwardStdin = (child: ChildProcess, socket: Socket): Transform => {
  const filter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString();
      if (SESSION_END_PATTERN.test(text)) {
        callback(null, Buffer.alloc(0));
        return;
      }
      callback(null, chunk);
    },
  });
  filter.on("error", () => { /* socket closed */ });
  filter.pipe(child.stdin!);
  socket.on("close", () => filter.unpipe(child.stdin!));
  return filter;
};

/**
 * 运行转发 server（进程内——供独立 daemon 入口与测试复用）。
 * 生产路径应经独立 daemon 入口（openarch lsp start 以 detached 进程运行）。
 */
export const runLspForwardServer = (
  cwd: string,
  launch: LspLaunchSpec,
  kind: LspDaemonKind,
): { readonly child: ChildProcess; readonly server: Server; readonly port: number } => {
  mkdirSync(cwd, { recursive: true });
  const child: ChildProcess = spawn(launch.command, launch.args as readonly string[], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(launch.environment ? { env: launch.environment } : {}),
  });
  child.on("error", (error) => { console.error(`[openarch-lsp] ${kind} spawn failed: ${error.message}`); });
  child.stderr?.on("data", () => { /* server 日志走 stderr，daemon 忽略 */ });
  child.stdin?.on("error", () => { /* client disconnected */ });
  child.stdout?.on("error", () => { /* client disconnected */ });

  const port = lspDaemonPort(cwd, kind);
  const server: Server = createServer((socket: Socket) => {
    socket.on("error", (error) => {
      if (process.env.OPENARCH_LSP_DEBUG === "1") console.error(`[openarch-lsp] session socket error: ${error.message}`);
    });
    child.stdout?.unpipe();
    const filter = forwardStdin(child, socket);
    socket.pipe(filter);
    child.stdout?.pipe(socket);
    socket.on("close", () => {
      socket.unpipe(filter);
      child.stdout?.unpipe(socket);
    });
  });
  server.on("error", (error) => {
    console.error(`[openarch-lsp] daemon server error: ${error.message}`);
  });
  server.listen(port, "127.0.0.1");
  child.on("exit", () => server.close());
  return { child, server, port };
};

export const runJdtlsForwardServer = (cwd: string, launch: LspLaunchSpec): { readonly child: ChildProcess; readonly server: Server; readonly port: number } =>
  runLspForwardServer(cwd, launch, "jdtls");

export const runGoplsForwardServer = (cwd: string, launch: LspLaunchSpec): { readonly child: ChildProcess; readonly server: Server; readonly port: number } =>
  runLspForwardServer(cwd, launch, "gopls");

/** 独立 daemon 进程入口：转发 + 保活（server 监听维持事件循环）。 */
export const runLspDaemonProcess = (cwd: string, launch: LspLaunchSpec, kind: LspDaemonKind): { readonly pid: number; readonly port: number } => {
  const { child, port } = runLspForwardServer(cwd, launch, kind);
  return { pid: child.pid!, port };
};

export const runJdtlsDaemonProcess = (cwd: string, launch: LspLaunchSpec): { readonly pid: number; readonly port: number } =>
  runLspDaemonProcess(cwd, launch, "jdtls");

export const runGoplsDaemonProcess = (cwd: string, launch: LspLaunchSpec): { readonly pid: number; readonly port: number } =>
  runLspDaemonProcess(cwd, launch, "gopls");

/** 启动转发 daemon（幂等：已活则返回现有状态）。 */
export const startLspDaemon = (
  cwd: string,
  launch: LspLaunchSpec,
  kind: LspDaemonKind,
  owner?: string,
): { readonly state: LspDaemonState; readonly started: boolean } => {
  const port = lspDaemonPort(cwd, kind);
  const stateFile = lspDaemonStateFile(cwd, kind);
  const existing = readState(stateFile);
  if (existing && isProcessAlive(existing.pid)) {
    if (owner) {
      const owners = [...new Set([...(existing.owners ?? []), owner])];
      writeState(stateFile, { ...existing, owners });
    }
    return { state: existing, started: false };
  }
  const { child } = runLspForwardServer(cwd, launch, kind);
  const state: LspDaemonState = {
    pid: child.pid!, port, cwd, startedAt: new Date().toISOString(),
    owners: owner ? [owner] : undefined,
  };
  writeState(stateFile, state);
  child.on("exit", () => {
    try { writeFileSync(stateFile, "{}", "utf8"); } catch { /* state already stale */ }
  });
  return { state, started: true };
};

export const startJdtlsDaemon = (cwd: string, launch: LspLaunchSpec, owner?: string): { readonly state: LspDaemonState; readonly started: boolean } =>
  startLspDaemon(cwd, launch, "jdtls", owner);

export const startGoplsDaemon = (cwd: string, launch: LspLaunchSpec, owner?: string): { readonly state: LspDaemonState; readonly started: boolean } =>
  startLspDaemon(cwd, launch, "gopls", owner);

/** 停止 daemon（hook Stop / 显式调用）：Windows 杀整个进程树。 */
export const stopLspDaemon = (cwd: string, kind: LspDaemonKind, owner?: string): boolean => {
  const stateFile = lspDaemonStateFile(cwd, kind);
  const state = readState(stateFile);
  if (!state) return false;
  if (owner && (state.owners ?? []).length > 0) {
    const remaining = (state.owners ?? []).filter((item) => item !== owner);
    if (remaining.length > 0) {
      writeState(stateFile, { ...state, owners: remaining });
      return false;
    }
  }
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/T", "/F", "/PID", String(state.pid)], { stdio: "ignore", windowsHide: true });
    } catch { /* already gone */ }
  } else {
    try {
      process.kill(state.pid, "SIGKILL");
    } catch { /* already gone */ }
  }
  try { writeFileSync(stateFile, "{}", "utf8"); } catch { /* stale */ }
  return true;
};

export const stopJdtlsDaemon = (cwd: string, owner?: string): boolean => stopLspDaemon(cwd, "jdtls", owner);
export const stopGoplsDaemon = (cwd: string, owner?: string): boolean => stopLspDaemon(cwd, "gopls", owner);

/** daemon 状态（供 status 命令）。 */
export const lspDaemonStatus = (cwd: string, kind: LspDaemonKind): { readonly running: boolean; readonly state?: LspDaemonState } => {
  const state = readState(lspDaemonStateFile(cwd, kind));
  if (!state || !isProcessAlive(state.pid)) return { running: false };
  return { running: true, state };
};

export const jdtlsDaemonStatus = (cwd: string): { readonly running: boolean; readonly state?: LspDaemonState } =>
  lspDaemonStatus(cwd, "jdtls");

export const goplsDaemonStatus = (cwd: string): { readonly running: boolean; readonly state?: LspDaemonState } =>
  lspDaemonStatus(cwd, "gopls");
