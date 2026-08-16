// packages/core/src/adapter/parser/QueryResultCache.ts
// Best-effort cross-process cache for tree-sitter query matches.
//
// Safety boundary: a query result depends only on (grammar, pattern, file
// content). It does not depend on other files, project configuration, import
// graphs or provider semantics, so content-addressed entries can never become
// "stale but valid-looking". The cache is never authoritative: any read,
// write, serialization or validation failure falls back to a fresh parse.
//
// Lifecycle: entries live in the OS temp directory under a project-root key.
// They are disposable and rebuildable; removal never changes governance facts.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { QueryMatch } from "../../port/ParserService";
import { projectRoot } from "../../infra/paths";

const SCHEMA_VERSION = "1";
const MAX_ENTRIES = 1024;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const isQueryCapture = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const capture = value as Record<string, unknown>;
  return typeof capture.name === "string"
    && typeof capture.text === "string"
    && typeof capture.startLine === "number"
    && typeof capture.endLine === "number"
    && typeof capture.startIndex === "number"
    && typeof capture.endIndex === "number";
};

const isQueryMatch = (value: unknown): value is QueryMatch =>
  !!value && typeof value === "object"
  && Array.isArray((value as { captures?: unknown }).captures)
  && (value as { captures: unknown[] }).captures.every(isQueryCapture);

const isQueryMatchArray = (value: unknown): value is QueryMatch[] =>
  Array.isArray(value) && value.every(isQueryMatch);

const cacheRoot = (): string => join(tmpdir(), "openarch-tree-query-cache", sha256(projectRoot()));

const cacheFilePath = (root: string, key: string): string => join(root, `${key}.json`);

export interface QueryResultCache {
  readonly keyFor: (code: string, pattern: string, grammarKey: string) => string;
  readonly get: (key: string) => QueryMatch[] | undefined;
  readonly put: (key: string, matches: readonly QueryMatch[]) => void;
}

export const createQueryResultCache = (rootOverride?: string): QueryResultCache => {
  let directory: string | undefined;
  let directoryPrepared = false;
  let cleaned = false;

  const prepareDirectory = (): string | undefined => {
    if (directoryPrepared) return directory;
    directoryPrepared = true;
    if (rootOverride !== undefined) {
      try {
        mkdirSync(rootOverride, { recursive: true });
        directory = rootOverride;
      } catch {
        directory = undefined;
      }
      return directory;
    }
    if (process.env.OPENARCH_TREE_QUERY_CACHE === "0") return undefined;
    try {
      const root = cacheRoot();
      mkdirSync(root, { recursive: true });
      directory = root;
    } catch {
      directory = undefined; // 只读/权限受限环境：直接退化为无缓存
    }
    return directory;
  };

  const cleanupOnce = (root: string): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      const now = Date.now();
      const files = readdirSync(root)
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          const path = join(root, name);
          try { return { path, mtimeMs: statSync(path).mtimeMs }; } catch { return undefined; }
        })
        .filter((entry): entry is { path: string; mtimeMs: number } => entry !== undefined)
        .sort((left, right) => left.mtimeMs - right.mtimeMs);
      let removed = 0;
      for (const entry of files) {
        if (files.length - removed <= MAX_ENTRIES && now - entry.mtimeMs <= MAX_AGE_MS) break;
        try { unlinkSync(entry.path); removed += 1; } catch { /* 其他进程可能正在读写；下次再清 */ }
      }
    } catch {
      // 清理失败不影响查询正确性。
    }
  };

  return {
    keyFor: (code, pattern, grammarKey) => sha256(`${SCHEMA_VERSION}\0${grammarKey}\0${pattern}\0${code}`),

    get(key) {
      const root = prepareDirectory();
      if (!root) return undefined;
      const path = cacheFilePath(root, key);
      try {
        if (!existsSync(path)) return undefined;
        const payload = readFileSync(path, "utf8");
        if (payload.length > MAX_ENTRY_BYTES) return undefined;
        const parsed = JSON.parse(payload) as unknown;
        return isQueryMatchArray(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },

    put(key, matches) {
      const root = prepareDirectory();
      if (!root) return;
      cleanupOnce(root);
      const serialized = JSON.stringify(matches);
      if (serialized.length > MAX_ENTRY_BYTES) return;
      // 缓存是 best-effort：直接写文件即可。写入中断只会产生一条被 get()
      // 校验丢弃的坏记录，不会产生半真事实。随机临时名避免跨进程互相覆盖。
      const temporary = join(root, `${key}-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
      try {
        writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx" });
        renameSync(temporary, cacheFilePath(root, key));
      } catch {
        // 并发/权限/文件锁失败：跳过缓存。
      } finally {
        try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* ignore */ }
      }
    },
  };
};
