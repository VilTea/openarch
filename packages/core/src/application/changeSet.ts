import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isAnalyzableProjectFile, readProjectFileKindRules, readProjectLanguages } from "../projectFiles";
import type { GovernancePopulation } from "../domain/fileParticipation";
import type { ChangeSetContext, ChangeSetFile } from "../anti-patterns/engine";
import { MAX_GIT_BLOB_BYTES, readGitBlobs, type SourceText } from "./gitBlobBatch";
import { toPosixPath } from "../infra/paths";
export { collectGitCommitHistory, type GitCommitHistory } from "./gitCommitHistory";

type GitStatus = { readonly path: string; readonly beforePath?: string; readonly kind: ChangeSetFile["kind"] };

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });

const gitPrefix = (cwd: string): string => git(cwd, ["rev-parse", "--show-prefix"]).trim().replace(/\\/g, "/");

const repositoryPath = (prefix: string, projectPath: string): string =>
  `${prefix}${toPosixPath(projectPath)}`;

const relativePath = (cwd: string, path: string): string =>
  relative(cwd, resolve(cwd, path)).replace(/\\/g, "/");

const parseStatus = (raw: string): readonly GitStatus[] => {
  const parts = raw.split("\0").filter(Boolean);
  const statuses: GitStatus[] = [];
  for (let index = 0; index < parts.length;) {
    const status = parts[index++];
    const code = status[0];
    if (!code) continue;
    if (code === "R" || code === "C") {
      const beforePath = parts[index++];
      const path = parts[index++];
      if (path) statuses.push({ path, beforePath, kind: "modified" });
      continue;
    }
    const path = parts[index++];
    if (!path) continue;
    statuses.push({ path, kind: code === "A" ? "added" : code === "D" ? "deleted" : "modified" });
  }
  return statuses;
};

const readCurrentText = (path: string): SourceText => {
  if (!existsSync(path)) return { omitted: false };
  if (statSync(path).size > MAX_GIT_BLOB_BYTES) return { omitted: true };
  return { text: readFileSync(path, "utf8"), omitted: false };
};

export type ChangeSetPopulation = Extract<GovernancePopulation, "production-governance" | "change-evidence">;

export interface ChangeSetOptions {
  /** Defaults to production; change evidence admits tests but never auxiliary inputs. */
  readonly population?: ChangeSetPopulation;
  /** Staged evidence must read the index blob, never a later unstaged worktree edit. */
  readonly source?: "worktree" | "staged";
}

/** Builds bounded source-only change facts. No Git fact is represented as a clean change set. */
export const collectGitChangeSet = (cwd: string, requestedPaths: readonly string[] = [], options: ChangeSetOptions = {}): ChangeSetContext => {
  try {
    const staged = options.source === "staged";
    const prefix = gitPrefix(cwd);
    const gitPaths = requestedPaths.map((path) => relativePath(cwd, path));
    const separator = gitPaths.length > 0 ? ["--", ...gitPaths] : ["--"];
    const tracked = parseStatus(git(cwd, [
      "diff", ...(staged ? ["--cached"] : []), "--relative", "--name-status", "--find-renames", "-z",
      ...(staged ? ["HEAD"] : []), ...separator,
    ]));
    const trackedPaths = new Set(tracked.map((entry) => entry.path));
    const untracked = staged ? [] : git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", ...separator])
      .split("\0").filter(Boolean)
      .filter((path) => !trackedPaths.has(path))
      .map((path): GitStatus => ({ path, kind: "added" }));
    const languages = readProjectLanguages(cwd);
    const fileKindRules = readProjectFileKindRules(cwd);
    const candidates = [...tracked, ...untracked].filter((status) =>
      isAnalyzableProjectFile(resolve(cwd, status.path), {
        cwd, languages, fileKindRules,
        population: options.population ?? "production-governance",
      }),
    );
    // worktree 语义：before 取 Git index 快照（未暂存改动的起点）；staged 语义：before 取 HEAD。
    const beforeObject = (status: GitStatus): string => `${staged ? `HEAD:` : ":"}${repositoryPath(prefix, status.beforePath ?? status.path)}`;
    const beforeTexts = readGitBlobs(cwd, candidates
      .filter((status) => status.kind !== "added")
      .map((status) => ({ key: status.path, object: beforeObject(status) })));
    const stagedAfterTexts = staged ? readGitBlobs(cwd, candidates
      .filter((status) => status.kind !== "deleted")
      .map((status) => ({ key: status.path, object: `:${repositoryPath(prefix, status.path)}` }))) : undefined;
    const omitted: string[] = [];
    const files = candidates.map((status): ChangeSetFile => {
      const absolutePath = resolve(cwd, status.path);
      const current = status.kind === "deleted"
        ? { omitted: false }
        : staged ? stagedAfterTexts?.get(status.path) ?? { omitted: false } : readCurrentText(absolutePath);
      const before = status.kind === "added" ? { omitted: false } : beforeTexts.get(status.path) ?? { omitted: false };
      if (current.omitted || before.omitted) omitted.push(status.path);
      return {
        path: toPosixPath(status.path), kind: status.kind,
        ...(status.beforePath ? { beforePath: toPosixPath(status.beforePath) } : {}),
        beforeText: before.text, afterText: current.text,
      };
    });
    return omitted.length > 0
      ? { availability: "partial", files, reason: `source text omitted for ${omitted.length} file(s) over ${MAX_GIT_BLOB_BYTES} bytes` }
      : { availability: "available", files };
  } catch (error) {
    return { availability: "unavailable", files: [], reason: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * Reads one committed revision through the same bounded source contract used by
 * change-set rules. Historical callers receive explicit partial/unavailable
 * states rather than treating a missing parent or oversized source as clean.
 */
export const collectGitRevisionChangeSet = (cwd: string, revision: string): ChangeSetContext => {
  try {
    const prefix = gitPrefix(cwd);
    const statuses = parseStatus(git(cwd, ["diff-tree", "--no-commit-id", "--relative", "--name-status", "--find-renames", "-z", "-r", revision]));
    let parent: string | undefined;
    try {
      parent = git(cwd, ["rev-parse", `${revision}^`]).trim() || undefined;
    } catch {
      parent = undefined;
    }
    const languages = readProjectLanguages(cwd);
    const fileKindRules = readProjectFileKindRules(cwd);
    const candidates = statuses.filter((status) =>
      isAnalyzableProjectFile(resolve(cwd, status.path), { cwd, languages, fileKindRules, population: "production-governance" }),
    );
    const beforeRequests = parent
      ? candidates.filter((status) => status.kind !== "added").map((status) => ({ key: `before:${status.path}`, object: `${parent}:${repositoryPath(prefix, status.beforePath ?? status.path)}` }))
      : [];
    const afterRequests = candidates.filter((status) => status.kind !== "deleted")
      .map((status) => ({ key: `after:${status.path}`, object: `${revision}:${repositoryPath(prefix, status.path)}` }));
    const blobs = readGitBlobs(cwd, [...beforeRequests, ...afterRequests]);
    const omitted: string[] = [];
    const files = candidates.map((status): ChangeSetFile => {
      const before = status.kind === "added" ? { omitted: false } : blobs.get(`before:${status.path}`) ?? { omitted: false };
      const after = status.kind === "deleted" ? { omitted: false } : blobs.get(`after:${status.path}`) ?? { omitted: false };
      if (before.omitted || after.omitted) omitted.push(status.path);
      return {
        path: toPosixPath(status.path), kind: status.kind,
        ...(status.beforePath ? { beforePath: toPosixPath(status.beforePath) } : {}),
        beforeText: before.text, afterText: after.text,
      };
    });
    return omitted.length > 0
      ? { availability: "partial", files, reason: `source text omitted for ${omitted.length} file(s) over ${MAX_GIT_BLOB_BYTES} bytes` }
      : { availability: "available", files };
  } catch (error) {
    return { availability: "unavailable", files: [], reason: error instanceof Error ? error.message : String(error) };
  }
};
