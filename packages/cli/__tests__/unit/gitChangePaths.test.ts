import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { GIT_CHANGE_PATHS_TIMEOUT_MS, gitChangePathResult, gitChangePaths } from "../../src/gitChangePaths";

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

  it("失败原因必须可诊断：命令、超时值、错误码、stderr 与耗时（校准 2026-09-25）", () => {
    // 历史症状：报告里只有 `spawnSync git ETIMEDOUT`，看不到命令/超时/stderr，
    // 使用方只能把它读成"本仓库不能做暂存门禁"。
    vi.mocked(execFileSync).mockImplementation(() => {
      const error = new Error("spawnSync git ETIMEDOUT") as Error & { code?: string; stderr?: string };
      error.code = "ETIMEDOUT";
      error.stderr = "fatal: whatever\nsecond line ignored";
      throw error;
    });

    const result = gitChangePathResult("project", "staged");
    expect(result.availability).toBe("unavailable");
    expect(result.reason).toContain("git diff --cached");
    expect(result.reason).toContain(`timeout=${GIT_CHANGE_PATHS_TIMEOUT_MS}ms`);
    expect(result.reason).toContain("code=ETIMEDOUT");
    expect(result.reason).toContain("elapsed=");
    expect(result.reason).toContain("stderr=fatal: whatever");
    // 只取 stderr 首行：多行 stderr 不应把报告行撑爆。
    expect(result.reason).not.toContain("second line ignored");
  });

  it("超时值只有一处权威定义（报告与探测共用同一常量）", () => {
    vi.mocked(execFileSync).mockReturnValueOnce("" as never);
    gitChangePathResult("project", "staged");
    expect(execFileSync).toHaveBeenCalledWith("git", expect.anything(),
      expect.objectContaining({ timeout: GIT_CHANGE_PATHS_TIMEOUT_MS }));
  });
});
