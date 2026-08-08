import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { LockService, type LockHandle } from "../../../src/port/LockService";
import { withGovernanceWriteLock } from "../../../src/application/governance/writeLock";

describe("withGovernanceWriteLock", () => {
  let released = 0;
  afterEach(() => { released = 0; });

  const handle: LockHandle = {
    name: "governance-state-write", agentId: "test", acquiredAt: 1, lockId: "lock-1",
  };

  it("releases the lock when the protected effect fails", async () => {
    const layer = Layer.succeed(LockService, {
      acquire: () => Effect.succeed(handle),
      release: () => Effect.sync(() => { released += 1; }),
    });
    const result = await Effect.runPromise(
      withGovernanceWriteLock("test", () => Effect.fail(new Error("protected failure")))
        .pipe(Effect.provide(layer), Effect.either),
    );

    expect(result._tag).toBe("Left");
    expect(released).toBe(1);
  });

  it("releases the lock after a successful protected effect", async () => {
    const layer = Layer.succeed(LockService, {
      acquire: () => Effect.succeed(handle),
      release: () => Effect.sync(() => { released += 1; }),
    });
    const result = await Effect.runPromise(
      withGovernanceWriteLock("test", () => Effect.succeed("ok"))
        .pipe(Effect.provide(layer)),
    );

    expect(result).toBe("ok");
    expect(released).toBe(1);
  });
});
