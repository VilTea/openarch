// packages/core/src/docs-repo/SymlinkManager.ts
//
// 跨平台软链接管理。design v5.2 §6.7。
// 优先级: POSIX symlink → Windows junction → 文本文件降级
import { symlinkSync, unlinkSync, readlinkSync, readFileSync, existsSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { platform } from "node:os";
import { atomicWriteTextSync } from "../adapter/storage/AtomicWriter";

const TEXT_FALLBACK_FILE = ".openarch/.docs-repo-path";

/** 创建指向 target 的符号链接（平台自适应降级） */
export const createSymlink = (target: string, linkPath: string): { method: "symlink" | "junction" | "text"; linkPath: string } => {
  // 确保父目录存在
  const parent = dirname(linkPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  // 如果已有链接/文件，先删
  if (existsSync(linkPath)) {
    try { unlinkSync(linkPath); } catch { rmdirSync(linkPath, { recursive: true }); }
  }

  // 1. POSIX: symlink
  if (platform() !== "win32") {
    symlinkSync(target, linkPath, "dir");
    return { method: "symlink", linkPath };
  }

  // 2. Windows: try junction (需要管理员权限)
  try {
    symlinkSync(target, linkPath, "junction");
    return { method: "junction", linkPath };
  } catch {
    // 3. 降级：文本文件记录 target 路径
    const fallback = join(dirname(linkPath), "..", TEXT_FALLBACK_FILE);
    const fallbackAbs = join(linkPath, "..", TEXT_FALLBACK_FILE);
    const actualFallback = isAbsolute(linkPath) ? join(dirname(linkPath), "..", TEXT_FALLBACK_FILE) : fallback;

    // Actually use the path relative to the .openarch dir
    mkdirSync(dirname(actualFallback), { recursive: true });
    atomicWriteTextSync(actualFallback, target);
    return { method: "text", linkPath: actualFallback };
  }
};

/** 读取符号链接目标（支持 symlink / junction / 文本降级） */
export const readSymlinkTarget = (linkPath: string): string | null => {
  try {
    if (platform() !== "win32") {
      return readlinkSync(linkPath);
    }
    // Windows: try readlink first
    try {
      return readlinkSync(linkPath);
    } catch {
      // 文本降级：读 .docs-repo-path 文件
      const fallback = join(dirname(linkPath), "..", TEXT_FALLBACK_FILE);
      if (existsSync(fallback)) {
        return readFileSync(fallback, "utf8").trim();
      }
      return null;
    }
  } catch {
    return null;
  }
};

/** 移除符号链接（保留目标内容） */
export const removeSymlink = (linkPath: string): void => {
  if (!existsSync(linkPath)) return;
  try {
    unlinkSync(linkPath);
  } catch {
    // junction / directory symlink
    try { rmdirSync(linkPath); } catch { /* ignore */ }
  }
  // 文本降级 clean up
  const fallback = join(dirname(linkPath), "..", TEXT_FALLBACK_FILE);
  if (existsSync(fallback)) {
    try { unlinkSync(fallback); } catch { /* ignore */ }
  }
};

/** 是否为有效链接（symlink / junction / text 降级均视为有效） */
export const isSymlinkValid = (linkPath: string): boolean => {
  try { statSync(linkPath); return true; } catch { /* text fallback or missing link */ }
  const target = readSymlinkTarget(linkPath);
  if (!target) return false;
  return existsSync(isAbsolute(target) ? target : resolve(dirname(linkPath), target));
};
