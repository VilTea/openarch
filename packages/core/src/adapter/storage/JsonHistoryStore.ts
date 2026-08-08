import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import type { StorageService } from "../../port/StorageService";
import { IoError } from "../../errors/errors";
import { atomicWriteJson } from "./AtomicWriter";
import { compactHistoryLedger, readHistoryReplayRecords } from "./HistoryLedger";

const safeEntryId = (value: string): boolean => /^[A-Za-z0-9._-]+$/.test(value);
const assertEntryId = (entryId: string): void => {
  if (!safeEntryId(entryId)) throw new Error("history entry id must be a single safe filename component");
};

type JsonHistoryStore = Pick<StorageService, "writeHistory" | "readHistoryEntry" | "readAllHistory" | "compactHistory">;

/** Owns immutable, content-addressed semantic history. */
export const createJsonHistoryStore = (rootDir: () => string): JsonHistoryStore => {
  const historyDir = () => `${rootDir()}/history`;
  return {
    writeHistory: (entryId, deltas, timestamp, diagnosis, evidence) =>
      Effect.tryPromise({
        try: async () => {
          assertEntryId(entryId);
          const directory = historyDir();
          mkdirSync(directory, { recursive: true });
          const path = join(directory, `${entryId}.json`);
          if (existsSync(path)) return;
          await atomicWriteJson(path, { timestamp, entryId, deltas, ...(diagnosis ? { diagnosis } : {}), ...(evidence ? { evidence } : {}) });
        },
        catch: (error) => new IoError({ path: join(historyDir(), entryId), cause: error }),
      }),

    readHistoryEntry: (entryId) =>
      Effect.try({
        try: () => {
          assertEntryId(entryId);
          const path = join(historyDir(), `${entryId}.json`);
          if (!existsSync(path)) return null;
          const raw = JSON.parse(readFileSync(path, "utf8"));
          return typeof raw.timestamp === "string" && raw.entryId === entryId && Array.isArray(raw.deltas) ? raw : null;
        },
        catch: (error) => new IoError({ path: join(historyDir(), entryId), cause: error }),
      }),

    readAllHistory: () =>
      Effect.try({
        try: () => {
          const directory = historyDir();
          return existsSync(directory) ? readHistoryReplayRecords(directory) : [];
        },
        catch: (error) => new IoError({ path: historyDir(), cause: error }),
      }),

    compactHistory: (rawWindowDays, now) =>
      Effect.tryPromise({
        try: () => compactHistoryLedger(historyDir(), rawWindowDays, now),
        catch: (error) => new IoError({ path: historyDir(), cause: error }),
      }),
  };
};
