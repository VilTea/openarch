import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { gitChangePathResult, gitChangePaths } from "../../src/gitChangePaths";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

describe("gitChangePaths", () => {
  it("includes untracked files only for worktree evidence", () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce("src/edited.ts\n" as never)
      .mockReturnValueOnce("src/new.ts\n" as never);

    expect(gitChangePaths("project", "worktree")).toEqual(["src/edited.ts", "src/new.ts"]);
    expect(execFileSync).toHaveBeenNthCalledWith(1, "git", expect.arrayContaining(["--relative"]), expect.anything());
  });

  it("uses only index paths for staged evidence", () => {
    vi.mocked(execFileSync).mockReturnValueOnce("src/staged.ts\n" as never);

    expect(gitChangePaths("project", "staged")).toEqual(["src/staged.ts"]);
    expect(execFileSync).toHaveBeenCalledWith("git", expect.arrayContaining(["--relative"]), expect.anything());
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it("does not turn a git failure into an empty change set", () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("not a git repository"); });

    expect(gitChangePathResult("project", "worktree")).toMatchObject({ availability: "unavailable", paths: [] });
    expect(() => gitChangePaths("project", "worktree")).toThrow(/unavailable/);
  });
});
