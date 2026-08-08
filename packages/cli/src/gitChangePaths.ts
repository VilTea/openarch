import { execFileSync } from "node:child_process";

export type GitChangeSource = "worktree" | "staged";

export interface GitChangePathsResult {
  readonly availability: "available" | "unavailable";
  readonly paths: readonly string[];
  readonly reason?: string;
}

const splitPaths = (raw: string): readonly string[] => (raw.includes("\0") ? raw.split("\0") : raw.split(/\r?\n/))
  .map((path) => path.trim())
  .filter(Boolean);

/**
 * Candidate source paths for the same Git facts that worktree/staged semantic
 * analysis consumes. Worktree includes untracked files; staged cannot.
 */
export const gitChangePathResult = (cwd: string, source: GitChangeSource): GitChangePathsResult => {
  try {
    const tracked = splitPaths(execFileSync(
      "git",
      source === "staged"
        ? ["diff", "--cached", "--relative", "--name-only", "-z", "--diff-filter=ACM"]
        : ["diff", "--relative", "--name-only", "-z", "--diff-filter=ACM"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 },
    ));
    if (source === "staged") return { availability: "available", paths: tracked };
    const untracked = splitPaths(execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 },
    ));
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
