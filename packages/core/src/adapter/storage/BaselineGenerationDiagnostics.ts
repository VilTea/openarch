import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readBaselineGenerationDirectory } from "./BaselineGenerationValidation";

export type BaselineGenerationArtifactKind = "staging" | "backup";
export type BaselineGenerationArtifactState = "valid" | "invalid";

export interface BaselineGenerationArtifact {
  readonly kind: BaselineGenerationArtifactKind;
  readonly path: string;
  readonly state: BaselineGenerationArtifactState;
  readonly ageMs: number;
  readonly snapshotSha256?: string;
  readonly reason?: string;
}

export interface BaselineGenerationDiagnostics {
  readonly active: "missing" | "valid" | "invalid";
  readonly readable: "active" | "backup" | "missing";
  readonly artifacts: readonly BaselineGenerationArtifact[];
}

const temporaryGeneration = /^baseline\.(staging|backup)-.+$/;
const baselineDirFor = (root: string): string => join(root, "baseline");

const generationArtifact = (
  root: string,
  name: string,
  kind: BaselineGenerationArtifactKind,
  now: number,
): BaselineGenerationArtifact => {
  const path = join(root, name);
  let ageMs = 0;
  try { ageMs = Math.max(0, now - statSync(path).mtimeMs); } catch { /* preserve an observable invalid artifact */ }
  try {
    const snapshot = readBaselineGenerationDirectory(path);
    return {
      kind, path, state: "valid", ageMs,
      ...(snapshot.index.meta.snapshotSha256 ? { snapshotSha256: snapshot.index.meta.snapshotSha256 } : {}),
    };
  } catch (error) {
    return {
      kind, path, state: "invalid", ageMs,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

/** Read-only facts for interrupted publication; never promotes or removes state. */
export const inspectBaselineGenerations = (root: string, now = Date.now()): BaselineGenerationDiagnostics => {
  const active = baselineDirFor(root);
  let activeState: BaselineGenerationDiagnostics["active"] = "missing";
  if (existsSync(active)) {
    try { readBaselineGenerationDirectory(active); activeState = "valid"; }
    catch { activeState = "invalid"; }
  }
  const artifacts = !existsSync(root) ? [] : readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && temporaryGeneration.test(entry.name))
    .map((entry) => {
      const match = temporaryGeneration.exec(entry.name)!;
      return generationArtifact(root, entry.name, match[1] as BaselineGenerationArtifactKind, now);
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const readable = activeState === "valid"
    ? "active"
    : artifacts.some((artifact) => artifact.kind === "backup" && artifact.state === "valid") ? "backup" : "missing";
  return { active: activeState, readable, artifacts };
};
