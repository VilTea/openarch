import { Effect } from "effect";
import { LockService, type LockError } from "../../port/LockService";

/**
 * One application-owned resource scope for durable governance mutations.
 * Adapters provide file formats and atomic primitives; they never acquire
 * this lock themselves.
 */
export const withGovernanceWriteLock = <A, E, R>(
  agentId: string,
  use: () => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | LockError, R | "LockService"> => Effect.gen(function* () {
  const lock = yield* LockService;
  return yield* Effect.acquireUseRelease(
    lock.acquire("governance-state-write", agentId),
    use,
    (handle) => lock.release(handle),
  );
});
