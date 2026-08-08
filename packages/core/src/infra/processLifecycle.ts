import { spawnSync, type ChildProcess } from "node:child_process";

export const DEFAULT_PROCESS_TERMINATION_GRACE_MS = 250;
export const DEFAULT_PROCESS_TERMINATION_FORCE_WAIT_MS = 1_000;

export interface ProcessTerminationResult {
  /** Whether the child and its owned process group were observed to exit. */
  readonly terminated: boolean;
  /** Whether graceful termination was followed by a forceful signal. */
  readonly forced: boolean;
}

const hasExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

const waitForChildExit = (child: ChildProcess, timeoutMs: number): Promise<boolean> => {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(result);
    };
    const onExit = (): void => finish(true);
    child.once("exit", onExit);
    timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
    if (hasExited(child)) finish(true);
  });
};

const processGroupExists = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForProcessGroupExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining)));
  }
  return true;
};

const signalProcessGroup = (child: ChildProcess, pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
};

const terminateDirectChild = async (child: ChildProcess): Promise<ProcessTerminationResult> => {
  try { child.kill("SIGTERM"); } catch { /* already exited */ }
  if (await waitForChildExit(child, DEFAULT_PROCESS_TERMINATION_GRACE_MS)) {
    return { terminated: true, forced: false };
  }
  try { child.kill("SIGKILL"); } catch { /* already exited */ }
  return {
    terminated: await waitForChildExit(child, DEFAULT_PROCESS_TERMINATION_FORCE_WAIT_MS),
    forced: true,
  };
};

/** Terminates a child and descendants with a bounded graceful-then-forceful lifecycle. */
export const terminateProcessTree = async (child: ChildProcess): Promise<ProcessTerminationResult> => {
  const pid = child.pid;
  if (!pid) {
    return terminateDirectChild(child);
  }
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
    if (result.status !== 0 && !hasExited(child)) {
      try { child.kill(); } catch { /* already exited */ }
    }
    return { terminated: await waitForChildExit(child, DEFAULT_PROCESS_TERMINATION_FORCE_WAIT_MS), forced: true };
  }
  if (!processGroupExists(pid)) {
    return terminateDirectChild(child);
  }
  signalProcessGroup(child, pid, "SIGTERM");
  const gracefullyTerminated = await Promise.all([
    waitForProcessGroupExit(pid, DEFAULT_PROCESS_TERMINATION_GRACE_MS),
    waitForChildExit(child, DEFAULT_PROCESS_TERMINATION_GRACE_MS),
  ]);
  if (gracefullyTerminated.every(Boolean)) {
    return { terminated: true, forced: false };
  }

  signalProcessGroup(child, pid, "SIGKILL");
  const forcefullyTerminated = await Promise.all([
    waitForProcessGroupExit(pid, DEFAULT_PROCESS_TERMINATION_FORCE_WAIT_MS),
    waitForChildExit(child, DEFAULT_PROCESS_TERMINATION_FORCE_WAIT_MS),
  ]);
  return { terminated: forcefullyTerminated.every(Boolean), forced: true };
};
