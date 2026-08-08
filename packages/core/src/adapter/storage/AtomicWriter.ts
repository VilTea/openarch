// packages/core/src/adapter/storage/AtomicWriter.ts
import writeFileAtomic from "write-file-atomic";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { retryTransientFileOperation } from "./TransientFileRetry";

/** Retries only transient file-lock failures; every individual attempt remains atomic. */
export const retryTransientAtomicWrite = retryTransientFileOperation;

/**
 * 原子写 JSON。write-file-atomic 负责单次原子替换；本层处理 Windows 的短暂文件锁。
 */
export const atomicWriteJson = async (path: string, data: unknown): Promise<void> => {
  const serialized = JSON.stringify(data, null, 2) + "\n";
  await retryTransientAtomicWrite(() => writeFileAtomic(path, serialized));
};

/** Writes only when the serialized document differs, avoiding timestamp-only churn. */
export const atomicWriteJsonIfChanged = async (path: string, data: unknown): Promise<boolean> => {
  const serialized = JSON.stringify(data, null, 2) + "\n";
  if (existsSync(path) && readFileSync(path, "utf8") === serialized) return false;
  await retryTransientAtomicWrite(() => writeFileAtomic(path, serialized));
  return true;
};

/** Atomic text publication for YAML/markdown state; callers own serialization and validation. */
export const atomicWriteText = async (path: string, text: string): Promise<void> => {
  await retryTransientAtomicWrite(() => writeFileAtomic(path, text));
};

export const atomicWriteTextIfChanged = async (path: string, text: string): Promise<boolean> => {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  await atomicWriteText(path, text);
  return true;
};

/** Synchronous atomic text publication for initialization APIs that remain synchronous. */
export const atomicWriteTextSync = (path: string, text: string): void => {
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* preserve the original publication error */ }
    }
  }
};
