import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { execFileHidden, gitRepositoryPrefix, openarchBase, repositoryPathOf } from "@openarch/core";

export interface StoredEvidence { readonly file: string; readonly sha256: string; }

export type WorktreeEvidenceState = "current" | "missing" | "stale";

const evidenceSignature = (entries: readonly StoredEvidence[]): string =>
  [...new Set(entries.map((entry) => `${entry.file}:${entry.sha256}`))].sort().join("|");

const normalizePath = (path: string): string => path.replace(/\\/g, "/");

/**
 * Read-only freshness check for guide: a matching pending candidate means the
 * current worktree was already measured and should not be measured again.
 */
export const worktreeEvidenceState = (cwd: string, paths: readonly string[]): WorktreeEvidenceState => {
  const base = openarchBase();
  const pendingPath = resolve(isAbsolute(base) ? base : resolve(cwd, base), "pending", "diff.json");
  if (!existsSync(pendingPath)) return "missing";
  try {
    const pending = JSON.parse(readFileSync(pendingPath, "utf8")) as { evidence?: readonly StoredEvidence[] };
    if (!Array.isArray(pending.evidence)) return "stale";
    const current = paths.flatMap((path) => {
      const absolute = resolve(cwd, path);
      return existsSync(absolute)
        ? [{ file: normalizePath(path), sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex") }]
        : [];
    });
    return evidenceSignature(pending.evidence) === evidenceSignature(current) ? "current" : "stale";
  } catch {
    return "stale";
  }
};

export const missingStagedEvidence = (staged: readonly StoredEvidence[], history: readonly { readonly evidence?: readonly StoredEvidence[] }[]): string[] => {
  const evidence = new Set(history.flatMap((entry) => entry.evidence ?? []).map((entry) => `${entry.file}:${entry.sha256}`));
  return staged.filter((entry) => !evidence.has(`${entry.file}:${entry.sha256}`)).map((entry) => entry.file);
};

// D-G17：前缀来自 core 的唯一权威（此前这里另写一份 `rev-parse --show-prefix`，
// 且**每个路径**都 spawn 一次）。现在前缀按调用取一次，再在循环里纯计算复用。
const stagedSha256 = (cwd: string, prefix: string, path: string): string =>
  createHash("sha256").update(execFileHidden("git", ["show", `:${repositoryPathOf(prefix, path)}`], {
    cwd, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
  })).digest("hex");

export const stagedEvidenceForPaths = (paths: readonly string[], cwd = process.cwd()): readonly StoredEvidence[] => {
  if (paths.length === 0) return [];
  const prefix = gitRepositoryPrefix(cwd);
  return paths.map((path) => ({ file: path, sha256: stagedSha256(cwd, prefix, path) }));
};

const stagedHistoryEvidence = (cwd: string): readonly { readonly evidence?: readonly StoredEvidence[] }[] => {
  const prefix = gitRepositoryPrefix(cwd);
  const paths = execFileHidden("git", ["diff", "--cached", "--name-only", "--diff-filter=AM", "-z", "--relative", "--", ".openarch/history"], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
  }).split("\0").map((path) => path.trim()).filter(Boolean);
  return paths.flatMap((path) => {
    try {
      return [JSON.parse(execFileHidden("git", ["show", `:${repositoryPathOf(prefix, path)}`], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
      }))];
    } catch { return []; }
  });
};

export const missingEvidenceForStagedFiles = (paths: readonly string[], cwd = process.cwd()): string[] =>
  missingStagedEvidence(stagedEvidenceForPaths(paths, cwd), stagedHistoryEvidence(cwd));
