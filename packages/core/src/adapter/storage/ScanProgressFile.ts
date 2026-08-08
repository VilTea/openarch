import { Effect, Layer } from "effect";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { IoError } from "../../errors/errors";
import { ScanProgressService, type ScanProgress } from "../../port/ScanProgressService";
import { atomicWriteJson } from "./AtomicWriter";

const ScanProgressSchema = z.object({
  version: z.literal("1"), status: z.enum(["running", "completed", "failed"]),
  phase: z.enum(["preparing", "parsing", "assembling", "publishing"]),
  completed: z.number().int().min(0), total: z.number().int().min(0),
  startedAt: z.string().min(10), updatedAt: z.string().min(10),
  nFiles: z.number().int().min(0).optional(), reason: z.string().min(1).optional(),
});

/** A running marker older than this is an interrupted run until proven otherwise. */
export const SCAN_PROGRESS_STALE_AFTER_MS = 30_000;
export type ScanProgressLifecycle = "active" | "stale" | "terminal";

export const scanProgressLifecycle = (
  progress: ScanProgress,
  now = Date.now(),
  staleAfterMs = SCAN_PROGRESS_STALE_AFTER_MS,
): ScanProgressLifecycle => {
  if (progress.status !== "running") return "terminal";
  const updatedAt = Date.parse(progress.updatedAt);
  return Number.isFinite(updatedAt) && now - updatedAt > staleAfterMs ? "stale" : "active";
};

const baseDir = () => process.env.OPENARCH_BASE_DIR ?? ".openarch";
const layer = (rootDir: () => string) => Layer.succeed(ScanProgressService, {
  write: (progress) => Effect.tryPromise({
    try: async () => { mkdirSync(rootDir(), { recursive: true }); await atomicWriteJson(join(rootDir(), "scan-status.json"), progress); },
    catch: (cause) => new IoError({ path: join(rootDir(), "scan-status.json"), cause }),
  }),
  read: () => Effect.try({
    try: (): ScanProgress | null => {
      const path = join(rootDir(), "scan-status.json");
      return existsSync(path) ? ScanProgressSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : null;
    },
    catch: (cause) => new IoError({ path: join(rootDir(), "scan-status.json"), cause }),
  }),
});

export const ScanProgressFileLive = layer(baseDir);
export const makeScanProgressFileLive = (rootDir: string) => layer(() => rootDir);
