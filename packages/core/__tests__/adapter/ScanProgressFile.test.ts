import { describe, expect, it } from "vitest";
import { scanProgressLifecycle } from "../../src/adapter/storage/ScanProgressFile";

const progress = (status: "running" | "completed", updatedAt: string) => ({
  version: "1" as const, status, phase: "parsing" as const, completed: 1, total: 2,
  startedAt: "2026-08-01T00:00:00.000Z", updatedAt,
});

describe("scanProgressLifecycle", () => {
  it("keeps a recent running marker active", () => {
    expect(scanProgressLifecycle(progress("running", "2026-08-01T00:00:20.000Z"), Date.parse("2026-08-01T00:00:30.000Z"))).toBe("active");
  });

  it("marks an old running marker stale without rewriting it", () => {
    expect(scanProgressLifecycle(progress("running", "2026-08-01T00:00:00.000Z"), Date.parse("2026-08-01T00:01:00.000Z"))).toBe("stale");
  });

  it("does not relabel terminal progress", () => {
    expect(scanProgressLifecycle(progress("completed", "2026-08-01T00:00:00.000Z"), Date.parse("2026-08-02T00:00:00.000Z"))).toBe("terminal");
  });
});
