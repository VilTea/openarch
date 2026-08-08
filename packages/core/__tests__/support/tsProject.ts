import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** 一个临时 TS 项目中的文件：相对项目根路径 + 内容。 */
export interface ProjectFile {
  readonly path: string;
  readonly content: string;
}

export interface WithTsProjectOptions {
  /** 不传则不写 tsconfig.json（用于无 tsconfig 证据的 unavailable 场景）。 */
  readonly tsconfig?: Record<string, unknown>;
}

/**
 * 运行测试体并在结束后清理临时目录。回调返回 Promise 时（async 测试），
 * 必须等 Promise resolve 后才清理——否则 cwd 在异步体执行中途被删，
 * git/fs 操作 ENOENT（校准 2026-08-08：withGitRepo 曾因 finally 早删致
 * changeSurfaceFactsFor 的 gitDiffHunks 拿空变更）。
 */
const runAndCleanup = <T>(cwd: string, run: (cwd: string) => T): T => {
  const cleanup = (): void => {
    rmSync(cwd, { recursive: true, force: true });
  };
  const result = run(cwd);
  if (result instanceof Promise) {
    return result.finally(cleanup) as unknown as T;
  }
  cleanup();
  return result;
};

/**
 * 构造一次性 TypeScript 项目 fixture（测试膨胀治理 2026-08-08）：
 * 自动创建父目录、写 tsconfig、运行测试体、finally 清理。
 * 消除各测试文件重复的 tmpdir/mkdir/writeFileSync/rmSync 样板
 * （typescript.test.ts 曾有 15 处，fixtureBoilerplateRatio 超阈值 0.128 > 0.08）。
 */
export const withTsProject = <T>(
  files: readonly ProjectFile[],
  run: (cwd: string) => T,
  options: WithTsProjectOptions = {},
): T => {
  const cwd = join(tmpdir(), `openarch-symbol-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(cwd, { recursive: true });
  if (options.tsconfig) writeFileSync(join(cwd, "tsconfig.json"), JSON.stringify(options.tsconfig));
  for (const file of files) {
    const target = join(cwd, file.path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, file.content);
  }
  return runAndCleanup(cwd, run);
};

/** Git 仓库 fixture（changeSet 测试膨胀治理 2026-08-08）：建仓库 + 初始文件 + baseline commit，
 *  运行测试体后 finally 清理。自动写 .openarch/config.yml + 配置 git 身份。 */
export const withGitRepo = <T>(
  files: readonly ProjectFile[],
  run: (cwd: string) => T,
  options: { configYaml?: string; initCwd?: string } = {},
): T => {
  const cwd = join(tmpdir(), `openarch-git-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const gitRoot = options.initCwd ?? cwd;
  mkdirSync(join(cwd, ".openarch"), { recursive: true });
  writeFileSync(join(cwd, ".openarch", "config.yml"), options.configYaml ?? 'languages: ["typescript"]\n');
  for (const file of files) {
    const target = join(cwd, file.path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, file.content);
  }
  const git = (args: readonly string[]): void => {
    execFileSync("git", args, { cwd: gitRoot, stdio: "pipe" });
  };
  git(["init"]);
  git(["config", "user.email", "openarch@example.test"]);
  git(["config", "user.name", "OpenArch Test"]);
  git(["add", "."]);
  git(["commit", "-m", "baseline"]);
  return runAndCleanup(cwd, run);
};
