// packages/core/src/docs-repo/DocsRepoManager.ts
//
// 协作文档仓库管理（design v5.2 §6.7 + §8.5 + §3.3 核心设计假设）
// 职责：Git clone / symlink 关联 / 平台降级 / config 读写 / 幂等 / --unlink
//
// §3.3 核心设计假设：docs-repo 是协作状态的唯一事实源。
// 中心化服务仅为其实时缓存层。Phase 1 已通过 git pull/push 实现基础协作。
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, copyFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createSymlink, readSymlinkTarget, removeSymlink, isSymlinkValid } from "./SymlinkManager";
import { atomicWriteTextSync } from "../adapter/storage/AtomicWriter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocsRepoConfig {
  readonly version: string;
  readonly target: string;
  readonly type: "git-clone" | "local";
  readonly cloned_at: string;
  readonly auto_sync: boolean;
  readonly source_url?: string;
}

export interface AssociateResult {
  readonly config: DocsRepoConfig;
  readonly symlinkMethod: "symlink" | "junction" | "text";
  readonly symlinkPath: string;
  readonly wasCloned: boolean;
}

export interface UnlinkResult {
  readonly unlinked: boolean;
  readonly configBackupPath: string | null;
}

export interface StatusResult {
  readonly associated: boolean;
  readonly config: DocsRepoConfig | null;
  readonly symlinkValid: boolean;
}

export interface SyncStatus {
  readonly behind: number;   // commits behind remote (需要 git pull)
  readonly ahead: number;    // commits ahead of remote (本地未 push)
  readonly hasConflict: boolean;
  readonly remote: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONFIG_PATH = ".openarch/.docs-repo-config.json";
const CACHE_DIR = ".openarch/.docs-repo-cache";
const SYMLINK_PATH = ".openarch/docs-repo";

const resolvePath = (p: string, cwd: string): string =>
  isAbsolute(p) ? p : resolve(cwd, p);

/** A clone directory is an internal identifier, never a path derived from the remote URL. */
const cloneDirectoryName = (url: string): string =>
  `repo-${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;

const readConfig = (cwd: string): DocsRepoConfig | null => {
  const p = resolvePath(CONFIG_PATH, cwd);
  try { return JSON.parse(readFileSync(p, "utf8")) as DocsRepoConfig; } catch { return null; }
};

const writeConfig = (cwd: string, config: DocsRepoConfig): void => {
  const p = resolvePath(CONFIG_PATH, cwd);
  mkdirSync(dirname(p), { recursive: true });
  atomicWriteTextSync(p, JSON.stringify(config, null, 2) + "\n");
};

/** docs-repo 标准目录结构（design §3.3 + §6.7） */
const STANDARD_DIRS = [
  "decisions", "wisdom/patterns", "wisdom/anti_patterns", "config-templates",
  "mr-records", "sessions", "locks", "tasks", "meetings",
];

const createStandardDirs = (gitRoot: string): void => {
  for (const d of STANDARD_DIRS) {
    mkdirSync(join(gitRoot, d), { recursive: true });
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const associateFromUrl = (url: string, cwd: string): AssociateResult => {
  const cacheDir = resolvePath(CACHE_DIR, cwd);
  const symlinkPath = resolvePath(SYMLINK_PATH, cwd);

  mkdirSync(cacheDir, { recursive: true });
  const cloneTarget = join(cacheDir, cloneDirectoryName(url));

  const existingConfig = readConfig(cwd);
  const wasCloned = existsSync(cloneTarget) && existsSync(join(cloneTarget, ".git"));

  if (!wasCloned) {
    // `--` keeps a remote beginning with '-' from becoming a Git option; execFileSync never opens a shell.
    execFileSync("git", ["clone", "--depth=1", "--", url, cloneTarget], { cwd, stdio: "pipe", timeout: 30000 });
    createStandardDirs(cloneTarget);  // 首次 clone 建标准目录
  }

  const { method } = createSymlink(cloneTarget, symlinkPath);

  const config: DocsRepoConfig = {
    version: "5.2", target: cloneTarget, type: "git-clone",
    cloned_at: existingConfig?.cloned_at ?? new Date().toISOString(),
    auto_sync: existingConfig?.auto_sync ?? false, source_url: url,
  };
  writeConfig(cwd, config);

  return { config, symlinkMethod: method, symlinkPath, wasCloned };
};

export const associateFromLocal = (localPath: string, cwd: string): AssociateResult | { error: string } => {
  const symlinkPath = resolvePath(SYMLINK_PATH, cwd);
  const absPath = resolvePath(localPath, cwd);
  const existingConfig = readConfig(cwd);
  if (!existsSync(absPath)) return { error: `目录不存在: ${absPath}` };
  const { method } = createSymlink(absPath, symlinkPath);
  // 本地关联时也建标准目录（如果不存在）
  if (existsSync(join(absPath, ".git"))) createStandardDirs(absPath);
  const config: DocsRepoConfig = {
    version: "5.2",
    target: absPath,
    type: "local",
    cloned_at: existingConfig?.cloned_at ?? new Date().toISOString(),
    auto_sync: existingConfig?.auto_sync ?? false,
  };
  writeConfig(cwd, config);
  return { config, symlinkMethod: method, symlinkPath, wasCloned: false };
};

export const unlinkDocsRepo = (cwd: string): UnlinkResult => {
  const symlinkPath = resolvePath(SYMLINK_PATH, cwd);
  const config = readConfig(cwd);
  let configBackupPath: string | null = null;
  if (config) { const bp = resolvePath(CONFIG_PATH, cwd) + ".bak." + Date.now(); copyFileSync(resolvePath(CONFIG_PATH, cwd), bp); configBackupPath = bp; }
  removeSymlink(symlinkPath);
  return { unlinked: true, configBackupPath };
};

export const statusDocsRepo = (cwd: string): StatusResult => {
  const config = readConfig(cwd);
  return { associated: config !== null, config, symlinkValid: isSymlinkValid(resolvePath(SYMLINK_PATH, cwd)) };
};

/** 检查 docs-repo 与远程的同步状态（git fetch + ahead/behind） */
export const checkSyncStatus = (cwd: string): SyncStatus | null => {
  const config = readConfig(cwd);
  if (!config || config.type !== "git-clone") return null;

  const gitDir = config.target;
  if (!existsSync(join(gitDir, ".git"))) return { behind: 0, ahead: 0, hasConflict: false, remote: null };

  try {
    execSync("git fetch --quiet", { cwd: gitDir, stdio: "pipe", timeout: 15000 });

    const local = execSync("git rev-parse HEAD", { cwd: gitDir, encoding: "utf8", timeout: 5000 }).trim();
    let remote = null;
    try { remote = execSync("git rev-parse @{u}", { cwd: gitDir, encoding: "utf8", timeout: 5000 }).trim(); } catch { /* no upstream */ }
    if (!remote) return { behind: 0, ahead: 0, hasConflict: false, remote: null };

    const behind = parseInt(execSync(`git rev-list --count HEAD..@{u}`, { cwd: gitDir, encoding: "utf8", timeout: 5000 }).trim(), 10) || 0;
    const ahead = parseInt(execSync(`git rev-list --count @{u}..HEAD`, { cwd: gitDir, encoding: "utf8", timeout: 5000 }).trim(), 10) || 0;

    return { behind, ahead, hasConflict: false, remote };
  } catch {
    return { behind: 0, ahead: 0, hasConflict: false, remote: null };
  }
};
