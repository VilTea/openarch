import { spawn, type ChildProcess } from "node:child_process";
import type { ProjectTestExecution } from "../runner";
import { terminateProcessTree } from "../../infra/processLifecycle";

export const DEFAULT_PROJECT_PROCESS_TIMEOUT_MS = 120_000;
export const DEFAULT_PROJECT_PROCESS_OUTPUT_LIMIT = 64 * 1024;

export interface ProjectProcessOptions {
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
  readonly outputLimitChars?: number;
  readonly shell?: boolean;
  readonly signal?: AbortSignal;
}

const detailWithOutput = (reason: string, output: string): string =>
  output.length > 0 ? `${reason}: ${output}` : reason;

/** One bounded, terminable boundary for configured project test commands. */
export const runProjectProcess = (options: ProjectProcessOptions): Promise<ProjectTestExecution> => new Promise((resolve) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROJECT_PROCESS_TIMEOUT_MS;
  const outputLimit = options.outputLimitChars ?? DEFAULT_PROJECT_PROCESS_OUTPUT_LIMIT;
  let output = "";
  let settled = false;
  let aborting = false;
  let timer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  let child: ChildProcess;

  const append = (chunk: Buffer | string): void => {
    output = (output + String(chunk)).slice(-outputLimit);
  };
  const finish = (result: ProjectTestExecution): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (abortHandler && options.signal) options.signal.removeEventListener("abort", abortHandler);
    resolve(result);
  };
  const abort = (reason: string): void => {
    if (settled || aborting) return;
    aborting = true;
    void terminateProcessTree(child).then((termination) => {
      const cleanup = termination.terminated ? undefined : "process cleanup incomplete";
      finish({
        command: [options.command, ...options.args].join(" "),
        passed: false,
        detail: detailWithOutput([reason, cleanup].filter(Boolean).join("; "), output),
      });
    }).catch((error: unknown) => finish({
      command: [options.command, ...options.args].join(" "),
      passed: false,
      detail: detailWithOutput(`${reason}; process cleanup failed: ${error instanceof Error ? error.message : String(error)}`, output),
    }));
  };

  // Executable/OS failures are emitted asynchronously through `error`, but
  // invalid spawn arguments still throw synchronously before listeners exist.
  try {
    child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: options.shell ?? process.platform === "win32",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    finish({ command: [options.command, ...options.args].join(" "), passed: false, detail: error instanceof Error ? error.message : String(error) });
    return;
  }

  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", (error) => {
    if (aborting) return;
    finish({ command: [options.command, ...options.args].join(" "), passed: false, detail: detailWithOutput(error.message, output) });
  });
  child.on("close", (code, signal) => {
    if (aborting) return;
    finish({
      command: [options.command, ...options.args].join(" "),
      passed: code === 0,
      detail: code === 0 ? undefined : detailWithOutput(signal ? `terminated by ${signal}` : `exit ${code ?? "unknown"}`, output),
    });
  });
  timer = setTimeout(() => abort(`timed out after ${timeoutMs}ms`), timeoutMs);
  if (options.signal) {
    abortHandler = () => abort("aborted");
    if (options.signal.aborted) abortHandler();
    else options.signal.addEventListener("abort", abortHandler, { once: true });
  }
});
