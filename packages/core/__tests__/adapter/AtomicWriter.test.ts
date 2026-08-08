import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWriteJson, retryTransientAtomicWrite } from "../../src/adapter/storage/AtomicWriter";
import { TRANSIENT_FILE_RETRY_DELAYS_MS } from "../../src/adapter/storage/TransientFileRetry";

const tmp = () => join(tmpdir(), `openarch-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

describe("atomicWriteJson", () => {
  it("写入新文件", async () => {
    const p = tmp();
    await atomicWriteJson(p, { a: 1 });
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ a: 1 });
    rmSync(p);
  });

  it("覆盖既有文件（原子替换，无半写入）", async () => {
    const p = tmp();
    writeFileSync(p, JSON.stringify({ old: true }));
    await atomicWriteJson(p, { new: true });
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ new: true });
    rmSync(p);
  });

  it("不残留 .tmp 文件", async () => {
    const p = tmp();
    await atomicWriteJson(p, { a: 1 });
    const dir = dirname(p);
    const prefix = `${basename(p)}.`;
    const tmps = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.includes(".tmp."));
    expect(tmps.length).toBe(0);
    rmSync(p);
  });

  it("短暂 Windows 文件锁重试后完成写入", async () => {
    let attempts = 0;
    const waits: number[] = [];
    await retryTransientAtomicWrite(async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
    }, async (delay) => { waits.push(delay); });
    expect(attempts).toBe(3);
    expect(waits).toEqual([50, 100]);
    expect(TRANSIENT_FILE_RETRY_DELAYS_MS).toEqual([50, 100, 250, 500, 1_000, 2_000]);
  });

  it("非瞬态写入错误立即失败", async () => {
    let attempts = 0;
    await expect(retryTransientAtomicWrite(async () => {
      attempts += 1;
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }, async () => undefined)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(attempts).toBe(1);
  });
});
