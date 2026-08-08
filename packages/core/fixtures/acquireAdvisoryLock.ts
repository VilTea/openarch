import { Effect } from "effect";
import { makeAdvisoryLockAdapterLive } from "../src/adapter/lock/AdvisoryLock";
import { LockService } from "../src/port/LockService";

const [rootDir, name, agentId] = process.argv.slice(2);

if (!rootDir || !name || !agentId) throw new Error("Expected rootDir, name and agentId");

const acquire = Effect.gen(function* () {
  const lock = yield* LockService;
  return yield* lock.acquire(name, agentId);
}).pipe(Effect.provide(makeAdvisoryLockAdapterLive(rootDir)));

Effect.runPromise(acquire).then(
  (handle) => console.log(JSON.stringify({ status: "acquired", lockId: handle.lockId })),
  () => { process.exitCode = 1; },
);
