import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { connect as tcpConnect, type Socket } from "node:net";
import { basename, join } from "node:path";
import spawn from "cross-spawn";
import { decodeJsonRpc, encodeJsonRpc, type JsonRpcMessage } from "../../lsp/jsonRpc";
import { terminateProcessTree, type ProcessTerminationResult } from "../../infra/processLifecycle";
import { createDiagnosticReadiness } from "./LspDiagnosticReadiness";
import { dispatchIncomingLspMessages } from "./LspIncomingMessages";
import { createLspRequestTracker } from "./LspRequestTracker";

export interface LspSession {
  readonly notify: (method: string, params: unknown) => void;
  readonly request: <T>(method: string, params: unknown, timeoutMs?: number) => Promise<T>;
  /** Resolves when every requested source URI has received a standard diagnostics notification. */
  readonly waitForDiagnostics?: (uris: readonly string[], timeoutMs: number) => Promise<boolean>;
  readonly close: () => void | Promise<void>;
}

export interface LspLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Optional provider-scoped process environment for a server runtime dependency. */
  readonly environment?: NodeJS.ProcessEnv;
  /** "stdio" spawns a child process (default); "tcp" connects to a running daemon. */
  readonly transport?: "stdio" | "tcp";
  /** Required when transport === "tcp": daemon host/port to connect to. */
  readonly host?: string;
  readonly port?: number;
  /** "tree" (default) kills the process tree on close; "self" only kills the
   *  client process so its daemon child (e.g. gopls -remote=auto) survives. */
  readonly shutdown?: "tree" | "self";
}

export interface LspProcess {
  readonly stdin: {
    readonly write: (data: Uint8Array) => boolean;
    readonly on: (event: "error", listener: (error: Error) => void) => unknown;
  };
  readonly stdout: {
    readonly on: (event: "data", listener: (chunk: Buffer) => void) => unknown;
  };
  readonly on: (event: "error" | "exit", listener: (errorOrCode: Error | number | null) => void) => unknown;
  readonly kill: () => void;
  readonly killTree?: () => void | ProcessTerminationResult | Promise<ProcessTerminationResult>;
}

export type LspProcessFactory = (launch: LspLaunchSpec, cwd: string) => LspProcess;

/**
 * Providers state an executable protocol endpoint, never a platform shell
 * command. The Node runtime delegates Windows command-shim escaping to
 * cross-spawn; Unix-like platforms retain direct process execution.
 */
export const lspLaunchSpec = (executable: string): LspLaunchSpec => ({ command: executable, args: ["--stdio"] });

/** Case-insensitive env lookup: Node's process.env keys are case-sensitive, Windows env vars are not. */
const envAnyCase = (...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  return undefined;
};

/** Resolve a usable Windows command shell for batch launchers (COMSPEC varies in case across launchers). */
const windowsCommandShell = (): string => {
  const comSpec = envAnyCase("ComSpec", "COMSPEC");
  if (comSpec) return comSpec;
  const systemRoot = envAnyCase("SystemRoot", "SYSTEMROOT", "WINDIR", "windir");
  if (systemRoot) return join(systemRoot, "system32", "cmd.exe");
  return "cmd.exe";
};

const nodeProcessFactory: LspProcessFactory = (launch, cwd): LspProcess => {
  const { command, args } = launch;
  // Windows .bat/.cmd cannot be spawned directly (Node throws, it does not
  // emit "error"): wrap in cmd /c with verbatim arguments so a batch-based
  // toolchain (e.g. jdtls.bat) degrades to unavailable instead of crashing.
  // process.env keys are case-sensitive in Node while Windows env vars are
  // not; different launchers surface COMSPEC/ComSpec/SYSTEMROOT/SystemRoot,
  // so probe both cases before falling back to cmd.exe on PATH.
  const isWindowsBatch = process.platform === "win32" && /\.(bat|cmd)$/i.test(command);
  try {
    const child = isWindowsBatch
      ? spawn(windowsCommandShell(), ["/d", "/s", "/c", `"${command}" ${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`], {
          cwd, windowsHide: true, stdio: "pipe", windowsVerbatimArguments: true,
          ...(launch.environment ? { env: launch.environment } : {}),
        }) as ChildProcessWithoutNullStreams
      : spawn(command, args, {
          cwd, windowsHide: true, stdio: "pipe", detached: process.platform !== "win32",
          ...(launch.environment ? { env: launch.environment } : {}),
        }) as ChildProcessWithoutNullStreams;
    return Object.assign(child, { killTree: () => terminateProcessTree(child) }) as ChildProcessWithoutNullStreams & LspProcess;
  } catch (error) {
    // spawn() can throw synchronously (ENOENT for a batch with no cmd.exe,
    // invalid command path, ...). Surface it through the "error" event so the
    // existing failAll path turns it into unavailable, never a crash.
    const failure = error instanceof Error ? error : new Error(String(error));
    return {
      stdin: { write: () => false, on: () => undefined },
      stdout: { on: () => undefined },
      on: (event, listener) => { if (event === "error") setImmediate(() => listener(failure)); },
      kill: () => undefined,
      killTree: () => ({ terminated: true, forced: false }),
    };
  }
};

/**
 * TCP transport for daemon-backed LSP servers: connects to a running server
 * instead of spawning one. Closing the session only drops the connection;
 * the daemon stays alive for index reuse (it owns its own idle reaper).
 */
const tcpProcessFactory = (host: string, port: number): LspProcess => {
  const socket: Socket = tcpConnect({ host, port });
  return {
    stdin: {
      write: (data) => socket.write(data),
      on: (event, listener) => { if (event === "error") socket.on("error", listener); },
    },
    stdout: {
      on: (event, listener) => { if (event === "data") socket.on("data", listener); },
    },
    on: (event, listener) => { socket.on(event, listener); },
    kill: () => socket.destroy(),
    // 校准 2026-08-06：killTree 原为 no-op——close 后 socket 保持打开，
    // event loop 活跃，CLI 进程永不退出（check 报告完整但 timeout 杀）。
    // tcp 会话关闭 = 断开连接（daemon 保持 jdtls 存活），socket 必须 destroy。
    killTree: () => { socket.destroy(); return { terminated: true, forced: false }; },
  };
};

const lspProcessFor = (launch: LspLaunchSpec, cwd: string, createProcess: LspProcessFactory): LspProcess =>
  launch.transport === "tcp" && launch.host !== undefined && launch.port !== undefined
    ? tcpProcessFactory(launch.host, launch.port)
    : createProcess(launch, cwd);

type ProcessSignal = "SIGINT" | "SIGTERM";
const activeSignalCleanups = new Set<() => void | Promise<void>>();
const signalHandlers = new Map<ProcessSignal, () => void>();

const registerSignalCleanup = (cleanup: () => void | Promise<void>): (() => void) => {
  activeSignalCleanups.add(cleanup);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    if (signalHandlers.has(signal)) continue;
    const handler = (): void => {
      for (const active of [...activeSignalCleanups]) void active();
      // Closing the session removes the listener; the exit code preserves the
      // conventional signal result without taking ownership of the host exit.
      process.exitCode = signal === "SIGINT" ? 130 : 143;
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    activeSignalCleanups.delete(cleanup);
    if (activeSignalCleanups.size > 0) return;
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    signalHandlers.clear();
  };
};

/** Shared, bounded JSON-RPC process transport. Providers own LSP method semantics, not lifecycle/framing. */
export const startLspSession = (
  launch: LspLaunchSpec,
  cwd: string,
  createProcess: LspProcessFactory = nodeProcessFactory,
): LspSession => {
  const child = lspProcessFor(launch, cwd, createProcess);
  let buffer = Buffer.alloc(0);
  const diagnostics = createDiagnosticReadiness();
  const tracker = createLspRequestTracker((message) => { child.stdin.write(encodeJsonRpc(message)); });
  const killProcess = async (): Promise<void> => {
    try {
      if (launch.shutdown === "self") { child.kill(); return; }
      if (child.killTree) await child.killTree();
      else child.kill();
    } catch { try { child.kill(); } catch { /* already exited */ } }
  };
  let closed = false;
  let unregisterSignalCleanup = (): void => { /* assigned below */ };
  const terminate = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    unregisterSignalCleanup();
    diagnostics.close();
    tracker.failAll(new Error("LSP session closed"));
    await killProcess();
  };
  unregisterSignalCleanup = registerSignalCleanup(terminate);

  child.on("error", (error) => {
    // Fail in-flight requests AND pending diagnostic-readiness waits; without
    // the latter, waitForDiagnostics hangs until its own timeout after a
    // spawn failure (e.g. missing batch shell) instead of failing fast.
    diagnostics.close();
    tracker.failAll(error instanceof Error ? error : new Error(String(error)));
  });
  child.on("exit", (code) => {
    unregisterSignalCleanup();
    diagnostics.close();
    tracker.failAll(new Error(`LSP process ${basename(launch.command)} exited (${code ?? "signal"})`));
  });
  child.stdin.on("error", (error) => {
    diagnostics.close();
    tracker.failAll(error);
  });
  child.stdout.on("data", (chunk) => {
    try {
      const decoded = decodeJsonRpc(Buffer.concat([buffer, chunk]));
      buffer = Buffer.from(decoded.remaining);
      if (process.env.OPENARCH_LSP_DEBUG === "1" && decoded.messages.length > 0) {
        console.error(`[lsp] dispatch ${decoded.messages.length} msgs`);
      }
      dispatchIncomingLspMessages(decoded.messages, tracker.send, tracker.consumeResponse, diagnostics.observe);
    } catch (error) {
      tracker.failAll(error instanceof Error ? error : new Error(String(error)));
      void killProcess();
    }
  });

  return {
    notify: (method, params) => tracker.send({ jsonrpc: "2.0", method, params }),
    request: tracker.request,
    waitForDiagnostics: diagnostics.wait,
    close: terminate,
  };
};

/**
 * A provider supplies its protocol-specific launch arguments.  The transport
 * owns only process lifecycle and JSON-RPC framing: `gopls serve`, a bare
 * `rust-analyzer`, and `pyright-langserver --stdio` are deliberately distinct.
 */
export const startNodeLspSession = (launch: LspLaunchSpec, cwd: string): LspSession =>
  startLspSession(launch, cwd, nodeProcessFactory);
