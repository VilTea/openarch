import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import type { ToolchainRuntime } from "../../toolchain/types";

const executableExtensions = (): readonly string[] => process.platform === "win32"
  ? (process.env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT"])
  : [""];

const resolveExecutable = (name: string): string | undefined => {
  if (name.includes("/") || name.includes("\\")) return existsSync(name) ? name : undefined;
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of executableExtensions()) {
      const candidate = `${directory}/${name}${extension}`;
      if (existsSync(candidate)) return candidate;
    }
    const direct = `${directory}/${name}`;
    if (existsSync(direct)) return direct;
  }
  return undefined;
};

const isProjectLocalExecutable = (cwd: string, executable: string): boolean => {
  const fromRoot = relative(resolve(cwd), resolve(executable));
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
};

const requireFromAdapter = createRequire(import.meta.url);

/**
 * 模块可用性检测（A2 修复 2026-08-10）：双保险探测。
 * - 先试 require 加载（bun build --compile 单文件二进制：静态 import 的包被
 *   bundle 进产物，bun 内置 require 能命中 bundle 模块；而
 *   createRequire.resolve 按文件系统解析虚拟路径恒失败（使用者项目
 *   卡点 2026-08-10 的根因：typescript-compiler 恒 UNAVAILABLE → enforcing
 *   hook 永久阻塞提交）；
 * - require 失败再试 createRequire.resolve（node/tsx 运行时：ESM-only 包
 *   无法 require 加载，但 hoisted node_modules 可按文件系统 resolve）。
 * 两种环境（bundle / node）下至少一种成功，hasPackage 才返回 true。
 */
const resolvePackage = (specifier: string): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require(specifier);
    if (loaded !== undefined && loaded !== null) return true;
  } catch {
    // fall through to path-based resolution
  }
  try {
    requireFromAdapter.resolve(specifier);
    return true;
  } catch {
    return false;
  }
};

export const nodeToolchainRuntime: ToolchainRuntime = {
  platform: process.platform,
  environment: process.env,
  resolveExecutable,
  exists: existsSync,
  isFile: (path) => {
    try { return statSync(path).isFile(); } catch { return false; }
  },
  readDirectory: (path) => {
    try { return readdirSync(path); } catch { return []; }
  },
  readFile: (path) => {
    try { return readFileSync(path, "utf8"); } catch { return undefined; }
  },
  hasPackage: resolvePackage,
  isProjectLocalExecutable,
  version: (executable, args) => {
    const result = spawnSync(executable, args, { encoding: "utf8", timeout: 3000, windowsHide: true });
    if (result.error) return { ok: false, reason: result.error.message };
    if (result.status !== 0) return { ok: false, reason: (result.stderr || result.stdout || `exit ${result.status}`).trim() };
    return { ok: true, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
  },
};
