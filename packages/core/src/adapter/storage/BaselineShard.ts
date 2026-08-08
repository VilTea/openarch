import { createHash } from "node:crypto";

/**
 * Baseline entries are self-describing; the shard filename is only a stable
 * filesystem identifier. A full digest avoids the legacy separator encoding's
 * many-to-one collisions without making paths machine-specific.
 */
export const baselineShardFileName = (path: string): string =>
  `sha256-${createHash("sha256").update(path).digest("hex")}.json`;

/** Read-only compatibility for generations written before TD-61. */
export const legacyBaselineShardFileName = (path: string): string =>
  `${path.replace(/[/\\:]/g, "__")}.json`;
