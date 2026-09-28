import { execFileHidden } from "./childProcess";
import { toPosixPath } from "./paths";

/**
 * git 仓库前缀（`git rev-parse --show-prefix`）的**唯一权威**（D-G17，2026-09-25）。
 *
 * 缺陷：同一件事实曾在**两处**各自实现——core 的 `application/changeSet.gitPrefix` 与
 * CLI 的 `semanticEvidence.repositoryPath`，且后者**每个路径**都 spawn 一次
 * （`stagedEvidenceForPaths` 对 N 个路径产生 N 次 rev-parse + N 次 `git show`）。
 * 一次 `check --staged` 因此出现 2 次相同调用（GIT_TRACE2_EVENT 实测）。
 *
 * 分层：前缀是 git 事实、与语言/治理无关，因此放在 infra，core 与 CLI 共用。
 * **调用热路径时用 `repositoryPathOf(prefix, path)`**：先取一次前缀再复用，
 * 不要在每个路径上重复 `gitRepositoryPrefix`。
 */
export const gitRepositoryPrefix = (cwd: string): string =>
  execFileHidden("git", ["rev-parse", "--show-prefix"], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
  }).trim().replace(/\\/g, "/");

/** 纯计算：把项目相对路径拼成 git 仓库相对路径（不 spawn，供已取到前缀的循环复用）。 */
export const repositoryPathOf = (prefix: string, projectRelativePath: string): string =>
  `${prefix}${toPosixPath(projectRelativePath)}`;

/** 便捷式：取前缀并立即拼路径。**单次调用**场景用它，循环里请改用 `repositoryPathOf`。 */
export const gitRepositoryPath = (cwd: string, projectRelativePath: string): string =>
  repositoryPathOf(gitRepositoryPrefix(cwd), projectRelativePath);
