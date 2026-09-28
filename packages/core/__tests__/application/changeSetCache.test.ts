import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { collectGitChangeSet, resetChangeSetCache } from "../../src/application/changeSet";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

/**
 * D-G17b（2026-09-25 项目所有者选择"备忘录 + 导出清除入口"）：
 * 同一次 `check --staged` 里 `antiPatterns` 与 `semanticProfiles` 各自解析同一份 staged
 * 变更集 ⇒ 同一组 git 读取被执行两遍（`GIT_TRACE2_EVENT` 实测 `--name-status` 2 次）。
 * 现在同一进程内相同请求只读一次 Git。
 *
 * 缓存的是"某一组 git 事实"，与时间无关；索引在本进程内被改动后必须 `resetChangeSetCache()`。
 */
describe("collectGitChangeSet 进程内备忘录（D-G17b）", () => {
  afterEach(() => {
    vi.mocked(execFileSync).mockReset();
    resetChangeSetCache();
  });

  const gitCalls = (): number => vi.mocked(execFileSync).mock.calls.length;

  it("相同请求第二次命中备忘录，不再触发 Git", () => {
    vi.mocked(execFileSync).mockReturnValue("" as never);
    collectGitChangeSet("C:/tmp/project", ["a.ts"], { source: "staged" });
    const first = gitCalls();
    expect(first).toBeGreaterThan(0);

    collectGitChangeSet("C:/tmp/project", ["a.ts"], { source: "staged" });
    expect(gitCalls()).toBe(first);
  });

  it("清除后重新读取（索引可能已变），不会给出陈旧快照", () => {
    vi.mocked(execFileSync).mockReturnValue("" as never);
    collectGitChangeSet("C:/tmp/project", ["a.ts"], { source: "staged" });
    const first = gitCalls();

    resetChangeSetCache();
    collectGitChangeSet("C:/tmp/project", ["a.ts"], { source: "staged" });
    expect(gitCalls()).toBeGreaterThan(first);
  });

  it("不同请求（工作树/staged、路径集不同）互不冒充", () => {
    vi.mocked(execFileSync).mockReturnValue("" as never);
    collectGitChangeSet("C:/tmp/project", ["a.ts"], { source: "staged" });
    const stagedOnce = gitCalls();
    collectGitChangeSet("C:/tmp/project", ["a.ts"], { source: "worktree" });
    expect(gitCalls()).toBeGreaterThan(stagedOnce);
    const worktreeOnce = gitCalls();
    collectGitChangeSet("C:/tmp/project", ["b.ts"], { source: "worktree" });
    expect(gitCalls()).toBeGreaterThan(worktreeOnce);
  });

  it("备忘录返回同一份事实对象（调用方不改写，故可共享）", () => {
    vi.mocked(execFileSync).mockReturnValue("" as never);
    const first = collectGitChangeSet("C:/tmp/project", ["a.ts"], { source: "staged" });
    const second = collectGitChangeSet("C:/tmp/project", ["a.ts"], { source: "staged" });
    expect(second).toBe(first);
  });
});
