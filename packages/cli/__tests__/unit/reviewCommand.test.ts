import { describe, expect, it, vi } from "vitest";

vi.mock("@openarch/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@openarch/core")>(),
  review: vi.fn(),
  collectGitCommitHistory: vi.fn(() => ({ availability: "unavailable", changeSets: [], reason: "not a Git repository" })),
  evolutionReview: vi.fn(),
}));

import { reviewCommand } from "../../src/commands/review";

describe("reviewCommand evolution view", () => {
  it("reports unavailable Git history instead of fabricating a clean co-change result", async () => {
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: string) => { output.push(line); });
    try {
      const result = await reviewCommand(["--evolution"], { cwd: "C:/not-a-repository", rawArgv: [], locale: "zh" });
      expect(result).toBe(0);
      expect(output.join("\n")).toContain("状态: UNAVAILABLE");
    } finally {
      log.mockRestore();
    }
  });
});
