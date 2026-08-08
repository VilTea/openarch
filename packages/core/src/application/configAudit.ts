import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openarchBase } from "../infra/paths";
import { atomicWriteTextSync } from "../adapter/storage/AtomicWriter";

export type ConfigAuditStatus = "initialized" | "recorded" | "unchanged" | "drift" | "uninitialized" | "missing_config";

export interface ConfigAuditResult {
  readonly status: ConfigAuditStatus;
  readonly currentHash?: string;
  readonly previousHash?: string;
  readonly eventPath?: string;
}

interface ConfigAuditState {
  readonly schemaVersion: "1";
  readonly hash: string;
  readonly recordedAt: string;
}

const contentHash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Explicit config audit. Gate stays read-only; CI uses check mode to reject unrecorded drift. */
export const auditConfig = (mode: "record" | "check" = "record", baseDir = openarchBase(), now = new Date()): ConfigAuditResult => {
  const config = join(baseDir, "config.yml");
  if (!existsSync(config)) return { status: "missing_config" };

  const currentHash = contentHash(readFileSync(config, "utf8"));
  const auditDir = join(baseDir, "audit");
  const statePath = join(auditDir, "config-state.json");
  let state: ConfigAuditState | undefined;
  if (existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<ConfigAuditState>;
      if (parsed.schemaVersion !== "1" || typeof parsed.hash !== "string" || !/^[0-9a-f]{64}$/.test(parsed.hash)
        || typeof parsed.recordedAt !== "string" || !Number.isFinite(new Date(parsed.recordedAt).getTime())) {
        throw new Error("malformed config audit state");
      }
      state = parsed as ConfigAuditState;
    } catch (error) {
      throw new Error(`config audit state unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!state) {
    if (mode === "check") return { status: "uninitialized", currentHash };
    mkdirSync(auditDir, { recursive: true });
    atomicWriteTextSync(statePath, JSON.stringify({ schemaVersion: "1", hash: currentHash, recordedAt: now.toISOString() }, null, 2) + "\n");
    return { status: "initialized", currentHash };
  }
  if (state.hash === currentHash) return { status: "unchanged", currentHash, previousHash: state.hash };
  if (mode === "check") return { status: "drift", currentHash, previousHash: state.hash };

  const eventsDir = join(auditDir, "config-events");
  mkdirSync(eventsDir, { recursive: true });
  const eventPath = join(eventsDir, `${now.toISOString().replace(/[:.]/g, "-")}.json`);
  atomicWriteTextSync(eventPath, JSON.stringify({ schemaVersion: "1", kind: "config_changed", recordedAt: now.toISOString(), previousHash: state.hash, currentHash }, null, 2) + "\n");
  atomicWriteTextSync(statePath, JSON.stringify({ schemaVersion: "1", hash: currentHash, recordedAt: now.toISOString() }, null, 2) + "\n");
  return { status: "recorded", currentHash, previousHash: state.hash, eventPath };
};
