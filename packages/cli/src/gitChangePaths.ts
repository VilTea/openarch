import { execFileHidden } from "@openarch/core";

export type GitChangeSource = "worktree" | "staged";

export interface GitChangePathsResult {
  readonly availability: "available" | "unavailable";
  readonly paths: readonly string[];
  readonly reason?: string;
}

/**
 * Git 只读探测的固定预算。导出为常量，使"超时值"只在这里定义一次
 * （报告与错误信息都读它，不再各写一个 5000）。
 */
export const GIT_CHANGE_PATHS_TIMEOUT_MS = 5000;

const splitPaths = (raw: string): readonly string[] => (raw.includes("\0") ? raw.split("\0") : raw.split(/\r?\n/))
  .map((path) => path.trim())
  .filter(Boolean);

/**
 * 失败必须可诊断（校准 2026-09-25）：原实现只回传 `error.message`，
 * 于是报告里只有 `spawnSync git ETIMEDOUT` —— 看不到命令、超时值、stderr 与耗时，
 * 使用方只能把它当成"本仓库不能做暂存门禁"。
 * 这里把一次 git 探测的完整事实拼进 reason；`availability` 形状不变，
 * 因此 `context-json` 契约无需变更。
 */
const describeGitFailure = (args: readonly string[], startedAt: number, error: unknown): string => {
  const detail = error as { message?: unknown; code?: unknown; stderr?: unknown } | null | undefined;
  const code = typeof detail?.code === "string" ? detail.code : undefined;
  const stderr = typeof detail?.stderr === "string" ? detail.stderr.trim().split(/\r?\n/)[0] : undefined;
  return [
    `git ${args.join(" ")}`,
    `timeout=${GIT_CHANGE_PATHS_TIMEOUT_MS}ms`,
    `elapsed=${Date.now() - startedAt}ms`,
    `code=${code ?? "unknown"}`,
    typeof detail?.message === "string" ? detail.message : String(error),
    stderr ? `stderr=${stderr}` : undefined,
  ].filter((part): part is string => part !== undefined).join(" | ");
};

const gitPaths = (cwd: string, args: readonly string[]): readonly string[] => {
  const startedAt = Date.now();
  try {
    return splitPaths(execFileHidden("git", args, {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_CHANGE_PATHS_TIMEOUT_MS,
    }));
  } catch (error) {
    throw new Error(describeGitFailure(args, startedAt, error));
  }
};

/**
 * Candidate source paths for the same Git facts that worktree/staged semantic
 * analysis consumes. Worktree includes untracked files; staged cannot.
 */
export const gitChangePathResult = (cwd: string, source: GitChangeSource): GitChangePathsResult => {
  try {
    const tracked = gitPaths(cwd, source === "staged"
      ? ["diff", "--cached", "--relative", "--name-only", "-z", "--find-renames", "--diff-filter=ACMRD"]
      : ["diff", "--relative", "--name-only", "-z", "--find-renames", "--diff-filter=ACMRD"]);
    if (source === "staged") return { availability: "available", paths: tracked };
    const untracked = gitPaths(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
    return { availability: "available", paths: [...new Set([...tracked, ...untracked])] };
  } catch (error) {
    return { availability: "unavailable", paths: [], reason: error instanceof Error ? error.message : String(error) };
  }
};

/** Compatibility helper for callers that already handle process errors at their boundary. */
export const gitChangePaths = (cwd: string, source: GitChangeSource): readonly string[] => {
  const result = gitChangePathResult(cwd, source);
  if (result.availability === "unavailable") throw new Error(`git ${source} change set unavailable: ${result.reason ?? "unknown error"}`);
  return result.paths;
};
