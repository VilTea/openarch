import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Effect } from "effect";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LockService, type LockHandle } from "../../src/port/LockService";
import { makeAdvisoryLockAdapterLive } from "../../src/adapter/lock/AdvisoryLock";

const tmpDir = join(tmpdir(), `openarch-lock-${Date.now()}`);
const layer = makeAdvisoryLockAdapterLive(tmpDir);
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const childFixture = fileURLToPath(new URL("../../fixtures/acquireAdvisoryLock.ts", import.meta.url));

const acquire = (name: string, agentId = "test") =>
  Effect.gen(function* () {
    const svc = yield* LockService;
    return yield* svc.acquire(name, agentId);
  }).pipe(Effect.provide(layer));

const release = (h: LockHandle) =>
  Effect.gen(function* () {
    const svc = yield* LockService;
    return yield* svc.release(h);
  }).pipe(Effect.provide(layer));

const acquireInChild = (rootDir: string, name: string, agentId: string) => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
  const child = spawn(process.execPath, [tsxCli, childFixture, rootDir, name, agentId], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stderr }));
});

describe("AdvisoryLockAdapter", () => {
  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
  });
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const lockFile = (name: string) => join(tmpDir, `.${name}.lock`);
  const guardFile = (name: string) => join(tmpDir, `.${name}.acquire.lock`);
  const staleDeadOwner = (agentId: string) => ({
    pid: 999_999_999,
    agentId,
    heartbeat_ts: Date.now() - 31_000,
    acquired_at: Date.now() - 31_000,
    lock_id: `${agentId}-stale`,
  });

  it("acquire → release：正常获取并释放", async () => {
    const h = await Effect.runPromise(acquire("test-lock"));
    expect(h.name).toBe("test-lock");
    expect(h.agentId).toBe("test");
    await Effect.runPromise(release(h));
  });

  it("重复 acquire 同一锁 → LockError", async () => {
    const h = await Effect.runPromise(acquire("test-lock"));
    const either = await Effect.runPromise(acquire("test-lock").pipe(Effect.either));
    expect(either._tag).toBe("Left");
    await Effect.runPromise(release(h));
  });

  it("release 已释放的锁 → 无异常（幂等）", async () => {
    const h = await Effect.runPromise(acquire("test-lock"));
    await Effect.runPromise(release(h));
    await expect(Effect.runPromise(release(h))).resolves.toBeUndefined();
  });

  it("并发 acquire 同名锁 → 恰好一个成功", async () => {
    const results = await Promise.all([
      Effect.runPromise(acquire("concurrent", "a").pipe(Effect.either)),
      Effect.runPromise(acquire("concurrent", "b").pipe(Effect.either)),
    ]);
    const winners = results.filter((result) => result._tag === "Right");
    expect(winners).toHaveLength(1);
    await Effect.runPromise(release(winners[0]!.right));
  });

  it("两个独立 PID 并发 acquire 同名锁 → 恰好一个成功", { timeout: 30_000 }, async () => {
    const name = "multi-process";
    const results = await Promise.all([
      acquireInChild(tmpDir, name, "child-a"),
      acquireInChild(tmpDir, name, "child-b"),
    ]);
    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    expect(results.filter((result) => result.code === 1)).toHaveLength(1);
    expect(results.every((result) => result.stderr === "")).toBe(true);
    rmSync(lockFile(name), { force: true });
  });

  it("过期且 PID 已死亡的实际锁 → 由新持有者原子接管", async () => {
    writeFileSync(lockFile("stale-lock"), JSON.stringify(staleDeadOwner("dead-agent")));
    const handle = await Effect.runPromise(acquire("stale-lock", "successor"));
    const current = JSON.parse(readFileSync(lockFile("stale-lock"), "utf8"));
    expect(current.agentId).toBe("successor");
    expect(current.lock_id).toBe(handle.lockId);
    await Effect.runPromise(release(handle));
  });

  it("过期 acquisition guard 且 PID 已死亡 → 可恢复", async () => {
    writeFileSync(guardFile("stale-guard"), JSON.stringify(staleDeadOwner("dead-guard")));
    const handle = await Effect.runPromise(acquire("stale-guard", "successor"));
    expect(existsSync(guardFile("stale-guard"))).toBe(false);
    await Effect.runPromise(release(handle));
  });

  it("即使心跳过期，PID 仍存活的 acquisition guard 也不可夺取", async () => {
    writeFileSync(guardFile("live-guard"), JSON.stringify({
      ...staleDeadOwner("live-guard"), pid: process.pid,
    }));
    const result = await Effect.runPromise(acquire("live-guard", "successor").pipe(Effect.either));
    expect(result._tag).toBe("Left");
    rmSync(guardFile("live-guard"), { force: true });
  });

  it("即使心跳过期，PID 仍存活的实际锁也不可夺取", async () => {
    writeFileSync(lockFile("live-lock"), JSON.stringify({
      ...staleDeadOwner("live-lock"), pid: process.pid,
    }));
    const result = await Effect.runPromise(acquire("live-lock", "successor").pipe(Effect.either));
    expect(result._tag).toBe("Left");
    rmSync(lockFile("live-lock"), { force: true });
  });

  it("无法解析的实际锁记录 → fail closed", async () => {
    writeFileSync(lockFile("invalid-lock"), "not-json");
    const result = await Effect.runPromise(acquire("invalid-lock", "successor").pipe(Effect.either));
    expect(result._tag).toBe("Left");
    rmSync(lockFile("invalid-lock"), { force: true });
  });

  it("旧 handle release 不会删除后继锁", async () => {
    const handle = await Effect.runPromise(acquire("successor", "first"));
    writeFileSync(lockFile("successor"), JSON.stringify({
      pid: process.pid,
      agentId: "second",
      heartbeat_ts: Date.now(),
      acquired_at: Date.now(),
      lock_id: "successor-lock",
    }));
    await Effect.runPromise(release(handle));
    expect(existsSync(lockFile("successor"))).toBe(true);
    rmSync(lockFile("successor"), { force: true });
  });
});
