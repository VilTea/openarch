import { describe, expect, it } from "vitest";
import { runProjectProcess } from "../../src/test-governance/runners/projectProcess";

describe("project process lifecycle", () => {
  it("terminates a process that exceeds its deadline", async () => {
    const result = await runProjectProcess({
      cwd: process.cwd(), command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 5000)"], timeoutMs: 40, shell: false,
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("timed out");
  }, 5000);

  it("escalates when a child ignores SIGTERM", async () => {
    const result = await runProjectProcess({
      cwd: process.cwd(), command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], timeoutMs: 40, shell: false,
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("timed out");
  }, 5000);

  it("keeps failure output bounded", async () => {
    const result = await runProjectProcess({
      cwd: process.cwd(), command: process.execPath,
      args: ["-e", "process.stderr.write('x'.repeat(100000)); process.exit(1)"], timeoutMs: 5000, shell: false, outputLimitChars: 128,
    });
    expect(result.passed).toBe(false);
    expect(result.detail?.length).toBeLessThan(200);
  });

  it("normalizes synchronous spawn argument errors", async () => {
    const result = await runProjectProcess({
      cwd: process.cwd(), command: null as unknown as string, args: [], shell: false,
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toBeTruthy();
  });
});
