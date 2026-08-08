// Advisory file lock lifecycle. Filesystem state transitions live in LockFileStore.
import { Effect, Layer } from "effect";
import { LockService, type LockHandle, LockError } from "../../port/LockService";
import { createLockFileStore } from "./LockFileStore";

const lockDir = () => process.env.OPENARCH_BASE_DIR ?? ".openarch";
const HEARTBEAT_INTERVAL = 5000;

const lockLayer = (rootDir: () => string) => Layer.effect(
  LockService,
  Effect.gen(function* () {
    const files = createLockFileStore(rootDir);
    const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

    return {
      acquire: (name: string, agentId: string) =>
        Effect.try({
          try: (): LockHandle => {
            files.ensureRoot();
            const path = files.lockPath(name);
            const guard = files.claimGuard(name, agentId);
            try {
              const existing = files.read(path);
              if (files.exists(path) && !existing) {
                throw new LockError(name, "Lock exists but cannot be verified; refusing takeover");
              }
              if (existing) {
                if (!files.isZombie(existing, Date.now())) {
                  throw new LockError(name, `Lock held by pid=${existing.pid} agent=${existing.agentId}`);
                }
                files.deleteOwned(path, existing.lock_id);
              }

              const now = Date.now();
              const data = files.newData(agentId, now);
              files.writeExclusive(path, data);
              const timer = setInterval(() => {
                if (files.heartbeat(path, data.lock_id)) return;
                clearInterval(timer);
                heartbeatTimers.delete(data.lock_id);
              }, HEARTBEAT_INTERVAL);
              timer.unref();
              heartbeatTimers.set(data.lock_id, timer);
              return { name, agentId, acquiredAt: now, lockId: data.lock_id };
            } finally {
              files.deleteOwned(files.guardPath(name), guard.lock_id);
            }
          },
          catch: (error) => error instanceof LockError ? error : new LockError(name, String(error)),
        }),

      release: (handle: LockHandle) =>
        Effect.sync(() => {
          const path = files.lockPath(handle.name);
          const timer = heartbeatTimers.get(handle.lockId);
          if (timer) clearInterval(timer);
          heartbeatTimers.delete(handle.lockId);
          const data = files.read(path);
          if (data?.pid === process.pid && data.agentId === handle.agentId && data.acquired_at === handle.acquiredAt) {
            files.deleteOwned(path, handle.lockId);
          }
        }),
    };
  }),
);

/** Test/integration seam: isolates lock files without mutating process-wide configuration. */
export const makeAdvisoryLockAdapterLive = (rootDir: string) => lockLayer(() => rootDir);

/** Production layer keeps resolving OPENARCH_BASE_DIR when an effect is provided. */
export const AdvisoryLockAdapterLive = lockLayer(lockDir);
