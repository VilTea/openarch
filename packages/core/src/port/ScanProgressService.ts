import { Context, Effect } from "effect";
import { IoError } from "../errors/errors";

export type ScanPhase = "preparing" | "parsing" | "assembling" | "publishing";
export type ScanRunStatus = "running" | "completed" | "failed";

export interface ScanProgress {
  readonly version: "1";
  readonly status: ScanRunStatus;
  readonly phase: ScanPhase;
  readonly completed: number;
  readonly total: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly nFiles?: number;
  readonly reason?: string;
}

export interface ScanProgressService {
  readonly write: (progress: ScanProgress) => Effect.Effect<void, IoError>;
  readonly read: () => Effect.Effect<ScanProgress | null, IoError>;
}

export const ScanProgressService = Context.GenericTag<"ScanProgressService", ScanProgressService>("ScanProgressService");
