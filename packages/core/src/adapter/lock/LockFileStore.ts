import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { LockError } from "../../port/LockService";

export interface LockData {
  readonly pid: number;
  readonly agentId: string;
  readonly heartbeat_ts: number;
  readonly acquired_at: number;
  readonly lock_id: string;
}

const HEARTBEAT_TIMEOUT = 30_000;

const isLockData = (value: Partial<LockData>): value is LockData =>
  typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0
  && typeof value.agentId === "string"
  && Number.isFinite(value.heartbeat_ts)
  && Number.isFinite(value.acquired_at)
  && typeof value.lock_id === "string" && value.lock_id.length > 0;

const isProcessAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const isAlreadyPresent = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";

/** Filesystem state transitions for one advisory-lock namespace. */
export const createLockFileStore = (rootDir: () => string) => {
  const lockPath = (name: string) => join(rootDir(), `.${name}.lock`);
  const guardPath = (name: string) => join(rootDir(), `.${name}.acquire.lock`);
  const read = (path: string): LockData | null => {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockData>;
      return isLockData(value) ? value : null;
    } catch { return null; }
  };
  const owns = (data: LockData, lockId: string): boolean => data.lock_id === lockId;
  const isZombie = (data: LockData, now: number): boolean =>
    now - data.heartbeat_ts > HEARTBEAT_TIMEOUT && !isProcessAlive(data.pid);
  const writeExclusive = (path: string, data: LockData): void => {
    const fd = openSync(path, "wx");
    try {
      writeFileSync(fd, JSON.stringify(data));
    } catch (error) {
      closeSync(fd);
      unlinkSync(path);
      throw error;
    }
    closeSync(fd);
  };
  const deleteOwned = (path: string, lockId: string): boolean => {
    const current = read(path);
    if (!current || !owns(current, lockId)) return false;
    unlinkSync(path);
    return true;
  };
  const newData = (agentId: string, now: number): LockData => ({
    pid: process.pid, agentId, heartbeat_ts: now, acquired_at: now, lock_id: randomUUID(),
  });
  const claimGuard = (name: string, agentId: string): LockData => {
    const path = guardPath(name);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = Date.now();
      const guard = newData(agentId, now);
      try {
        writeExclusive(path, guard);
        return guard;
      } catch (error) {
        if (!isAlreadyPresent(error)) throw error;
        const existing = read(path);
        if (!existing) throw new LockError(name, "Acquire guard exists but cannot be verified; refusing takeover");
        if (!isZombie(existing, now)) throw new LockError(name, `Acquire in progress by pid=${existing.pid} agent=${existing.agentId}`);
        deleteOwned(path, existing.lock_id);
      }
    }
    throw new LockError(name, "Acquire guard changed during zombie recovery");
  };
  const heartbeat = (path: string, lockId: string): boolean => {
    const current = read(path);
    if (!current || !owns(current, lockId)) return false;
    writeFileSync(path, JSON.stringify({ ...current, heartbeat_ts: Date.now() }));
    return true;
  };

  return {
    ensureRoot: () => mkdirSync(rootDir(), { recursive: true }),
    exists: (path: string) => existsSync(path),
    lockPath,
    guardPath,
    read,
    owns,
    isZombie,
    writeExclusive,
    deleteOwned,
    newData,
    claimGuard,
    heartbeat,
  };
};
