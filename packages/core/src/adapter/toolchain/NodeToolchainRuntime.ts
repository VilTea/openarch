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

const requireFromAdapter = createRequire(import.meta.url);

const isProjectLocalExecutable = (cwd: string, executable: string): boolean => {
  const fromRoot = relative(resolve(cwd), resolve(executable));
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
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
  hasPackage: (specifier) => {
    try { requireFromAdapter.resolve(specifier); return true; } catch { return false; }
  },
  isProjectLocalExecutable,
  version: (executable, args) => {
    const result = spawnSync(executable, args, { encoding: "utf8", timeout: 3000, windowsHide: true });
    if (result.error) return { ok: false, reason: result.error.message };
    if (result.status !== 0) return { ok: false, reason: (result.stderr || result.stdout || `exit ${result.status}`).trim() };
    return { ok: true, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
  },
};
