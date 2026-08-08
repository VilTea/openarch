import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { sealPendingEvidence } from "../../src/application/governance/sealPendingEvidence";
import { LockService, type LockHandle } from "../../src/port/LockService";
import { StorageService, type StorageService as StorageContract } from "../../src/port/StorageService";

describe("sealPendingEvidence", () => {
  it("serializes finalize and compaction through one application-owned lock", async () => {
    const events: string[] = [];
    const handle: LockHandle = { name: "governance-state-write", agentId: "test", acquiredAt: 1, lockId: "lock" };
    const lock = {
      acquire: () => Effect.sync(() => { events.push("acquire"); return handle; }),
      release: () => Effect.sync(() => { events.push("release"); }),
    };
    const storage = {
      finalizePendingDiff: () => Effect.sync(() => { events.push("finalize"); return "finalized" as const; }),
      compactHistory: () => Effect.sync(() => { events.push("compact"); return { compactedEntries: 1, retainedEntries: 2 }; }),
    } as unknown as StorageContract;

    const result = await Effect.runPromise(sealPendingEvidence({
      stagedEvidence: [{ file: "src/a.ts", sha256: "a" }], rawWindowDays: 180,
    }).pipe(Effect.provide(Layer.merge(
      Layer.succeed(LockService, lock),
      Layer.succeed(StorageService, storage),
    ))));

    expect(result).toMatchObject({ status: "finalized", compaction: { compactedEntries: 1 } });
    expect(events).toEqual(["acquire", "finalize", "compact", "release"]);
  });

  it("does not compact or release pending state when evidence mismatches", async () => {
    const events: string[] = [];
    const handle: LockHandle = { name: "governance-state-write", agentId: "test", acquiredAt: 1, lockId: "lock" };
    const lock = {
      acquire: () => Effect.succeed(handle),
      release: () => Effect.sync(() => { events.push("release"); }),
    };
    const storage = {
      finalizePendingDiff: () => Effect.sync(() => { events.push("finalize"); return "mismatch" as const; }),
      compactHistory: () => Effect.sync(() => { events.push("compact"); return { compactedEntries: 0, retainedEntries: 0 }; }),
    } as unknown as StorageContract;

    const result = await Effect.runPromise(sealPendingEvidence({
      stagedEvidence: [{ file: "src/a.ts", sha256: "a" }], rawWindowDays: 180,
    }).pipe(Effect.provide(Layer.merge(
      Layer.succeed(LockService, lock),
      Layer.succeed(StorageService, storage),
    ))));

    expect(result).toEqual({ status: "mismatch" });
    expect(events).toEqual(["finalize", "release"]);
  });
});
