import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/** Gives one test exclusive temporary storage and removes it even when an assertion throws. */
export const withTemporaryDirectory = async <T>(
  prefix: string,
  run: (directory: string) => Promise<T> | T,
): Promise<T> => {
  const directory = mkdtempSync(join(tmpdir(), `openarch-${prefix}-`));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

/** 写项目语言指示文件（go.mod/pyproject.toml/Cargo.toml 等）——消除 initConfig 等
 *  测试重复的 mkdirSync(dir) + writeFileSync 样板（校准 2026-08-08：initConfig 103 行
 *  fixture 调用，其中语言指示文件是最大样板来源）。 */
export const writeProjectMarkers = (directory: string, markers: Record<string, string>): void => {
  for (const [name, content] of Object.entries(markers)) {
    writeFileSync(join(directory, name), content);
  }
};

/** git init + 身份配置（不创建 baseline commit——initApp 类测试自己管理提交）。 */
export const initGit = (cwd: string): void => {
  execFileSync("git", ["init", "--quiet"], { cwd });
  execFileSync("git", ["config", "user.email", "openarch@example.test"], { cwd });
  execFileSync("git", ["config", "user.name", "OpenArch Test"], { cwd });
};
