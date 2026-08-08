import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { LspLaunchSpec } from "../lsp/NodeLspSession";

/**
 * jdtls 转发 daemon（校准 2026-08-06：Java 单项目符号级刚需）。
 *
 * jdtls 无服务端监听模式（CLIENT_PORT 是单向客户端连接），且每会话冷启动
 * 360s（JVM + Maven 导入）。实测 jdtls 同一 stdio 进程接受重复 initialize
 * （会话 2 响应 0.0s）——因此用转发 daemon：长驻 jdtls（stdio）+ tcp server，
 * OpenArch cli 每次 check 连接 tcp，daemon 把连接转发到 jdtls 的 stdio。
 * 连接断开时保持 jdtls 进程存活（stdin 不 EOF），下一会话复用 JVM 与 Maven
 * 状态。拦截 LSP exit/shutdown 通知（不转发），避免 jdtls 退出。
 */

/** 项目绑定的 daemon 端口（40000-49999，按 cwd hash 稳定分配）。 */
export const jdtlsDaemonPort = (cwd: string): number => {
  const hash = createHash("sha256").update(cwd.replace(/\\/g, "/")).digest("hex").slice(0, 6);
  return 40000 + (parseInt(hash, 16) % 10000);
};

/** daemon 状态文件（记录 jdtls 子进程 PID + 端口——hook Stop 用它关闭）。 */
export const jdtlsDaemonStateFile = (cwd: string): string =>
  join(tmpdir(), "openarch-lsp", `jdtls-${jdtlsDaemonPort(cwd)}.json`);

export interface JdtlsDaemonState {
  readonly pid: number;
  readonly port: number;
  readonly cwd: string;
  readonly startedAt: string;
  /** 引用计数（多 harness 并发时的 stop 竞争保护，校准 2026-08-07）：
   * 每个 lsp start 记录调用者（harness 名），stop 只移除自己——owners 清空
   * 才杀 daemon；无 owner 的 stop（手动清理）直接杀。 */
  readonly owners?: readonly string[];
}

/** exit/shutdown 通知（LSP 会话结束信号）——不转发给 jdtls，保持进程存活。 */
const SESSION_END_PATTERN = /"method"\s*:\s*"(?:shutdown|exit)"/;

const writeState = (file: string, state: JdtlsDaemonState): void => {
  mkdirSync(join(tmpdir(), "openarch-lsp"), { recursive: true });
  writeFileSync(file, JSON.stringify(state), "utf8");
};

const readState = (file: string): JdtlsDaemonState | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as JdtlsDaemonState;
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

/**
 * 运行转发 server（进程内——供独立 daemon 入口与测试复用）。
 * 注意：server/pipe 绑定当前进程；作为 CLI 命令直接调用时 CLI 退出即死，
 * 生产路径应经独立 daemon 入口（openarch lsp start 以 detached 进程运行）。
 */
// jdtls 转发 daemon（校准 2026-08-06/07）：
// 内核是**通用 LSP 转发语义**——spawn stdio LSP server + tcp server + 双向 pipe +
// exit/shutdown 拦截 + 连接异常容忍——jdtls 只是当前实例（jdtls 无服务端监听、
// 每会话 360s 冷启动，必须常驻转发）。预热第二语言（如 rust-analyzer）时复用本
// 内核：仅需新的 launch 规格与状态文件前缀，转发逻辑零改动。
export const runJdtlsForwardServer = (cwd: string, launch: LspLaunchSpec): { readonly child: ChildProcess; readonly server: Server; readonly port: number } => {
  // cwd 不存在时 spawn 报 ENOENT（Windows）；daemon 应容忍调用方未预建目录
  mkdirSync(cwd, { recursive: true });
  const child: ChildProcess = spawn(launch.command, launch.args as readonly string[], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.on("error", (error) => { console.error(`[openarch-lsp] jdtls spawn failed: ${error.message}`); });
  child.stderr?.on("data", () => { /* jdtls 日志走 stderr，daemon 忽略 */ });
  // stdin/stdout 在连接断开/进程退出时可能 error（EPIPE/ECONNRESET）——
  // 未监听的 error 事件会让 daemon 进程崩溃（校准 2026-08-06：check 的 socket
  // 断开时 daemon 读 ECONNRESET 未处理崩溃——daemon 必须容忍连接异常）。
  child.stdin?.on("error", () => { /* client disconnected */ });
  child.stdout?.on("error", () => { /* client disconnected */ });

  const port = jdtlsDaemonPort(cwd);
  const server: Server = createServer((socket: Socket) => {
    // 会话 socket 的 error（客户端 RST/断开）——记录但不崩溃（daemon 保持存活）
    socket.on("error", (error) => {
      if (process.env.OPENARCH_LSP_DEBUG === "1") console.error(`[openarch-lsp] session socket error: ${error.message}`);
    });
    // 新会话：接上 jdtls 的 stdio（上一会话的 pipe 已在 close 时断开）
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
    // 端口被占/监听失败——记录但不崩（status 会报告未运行）
    console.error(`[openarch-lsp] daemon server error: ${error.message}`);
  });
  server.listen(port, "127.0.0.1");
  child.on("exit", () => server.close());
  return { child, server, port };
};

/** 独立 daemon 进程入口（openarch lsp start 以 detached 方式运行）：转发 + 保活（server 监听维持事件循环）。 */
export const runJdtlsDaemonProcess = (cwd: string, launch: LspLaunchSpec): { readonly pid: number; readonly port: number } => {
  const { child, port } = runJdtlsForwardServer(cwd, launch);
  return { pid: child.pid!, port };
};

/** 启动 jdtls 转发 daemon（幂等：已活则返回现有状态）。CLI 命令不应直接调用
 * （进程内 server 随 CLI 退出）；lsp start 用 runJdtlsDaemonProcess 的 detached 包装。 */
export const startJdtlsDaemon = (
  cwd: string,
  launch: LspLaunchSpec,
  owner?: string,
): { readonly state: JdtlsDaemonState; readonly started: boolean } => {
  const port = jdtlsDaemonPort(cwd);
  const stateFile = jdtlsDaemonStateFile(cwd);
  const existing = readState(stateFile);
  if (existing && isProcessAlive(existing.pid)) {
    // 幂等：复用现有 daemon，owner 去重追加（多 harness 各记一次）
    if (owner) {
      const owners = [...new Set([...(existing.owners ?? []), owner])];
      writeState(stateFile, { ...existing, owners });
    }
    return { state: existing, started: false };
  }
  const { child } = runJdtlsForwardServer(cwd, launch);
  const state: JdtlsDaemonState = {
    pid: child.pid!, port, cwd, startedAt: new Date().toISOString(),
    owners: owner ? [owner] : undefined,
  };
  writeState(stateFile, state);
  child.on("exit", () => {
    try { writeFileSync(stateFile, "{}", "utf8"); } catch { /* state already stale */ }
  });
  return { state, started: true };
};

/** 把 socket 数据转发到 jdtls stdin，拦截 LSP exit/shutdown（保持进程）。 */
const forwardStdin = (child: ChildProcess, socket: Socket): Transform => {
  const filter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString();
      if (SESSION_END_PATTERN.test(text)) {
        // 丢弃 exit/shutdown 通知——jdtls 会话复用（校准 2026-08-06）
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

/** 停止 daemon（hook Stop / 显式调用）：taskkill /T 杀整个进程树（Windows——jdtls 的
 * JVM 子进程、cmd /c 包装的 node 子进程都会残留，仅 kill 父 PID 不够）。 */
export const stopJdtlsDaemon = (cwd: string, owner?: string): boolean => {
  const stateFile = jdtlsDaemonStateFile(cwd);
  const state = readState(stateFile);
  if (!state) return false;
  // 引用计数：有 owner 且还有其他 owner 时只移除自己，不杀 daemon
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

/** daemon 状态（供 status 命令）。 */
export const jdtlsDaemonStatus = (cwd: string): { readonly running: boolean; readonly state?: JdtlsDaemonState } => {
  const state = readState(jdtlsDaemonStateFile(cwd));
  if (!state || !isProcessAlive(state.pid)) return { running: false };
  return { running: true, state };
};
