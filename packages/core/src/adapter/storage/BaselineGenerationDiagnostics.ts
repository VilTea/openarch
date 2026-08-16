import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readBaselineGenerationDirectory, validateBaselineGenerationDirectory } from "./BaselineGenerationValidation";

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

/** Fast path for `context`: index parses and the canonical shard count matches `nFiles`. It does not recompute the content-addressed snapshot identity; full validation stays in scan/review/gate read paths. */
const shallowActiveState = (directory: string): "valid" | "invalid" => {
  try {
    const index = JSON.parse(readFileSync(join(directory, "_index.json"), "utf8"));
    if (!index || typeof index !== "object" || typeof index.meta?.nFiles !== "number") return "invalid";
    const shards = readdirSync(directory).filter((name) => /^sha256-[0-9a-f]{64}\.json$/.test(name));
    return shards.length === index.meta.nFiles ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
};

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
export const inspectBaselineGenerations = (root: string, now = Date.now(), options: { readonly deep?: boolean } = {}): BaselineGenerationDiagnostics => {
  const deep = options.deep !== false;
  const active = baselineDirFor(root);
  let activeState: BaselineGenerationDiagnostics["active"] = "missing";
  if (existsSync(active)) {
    if (deep) {
      try { validateBaselineGenerationDirectory(active); activeState = "valid"; }
      catch { activeState = "invalid"; }
    } else {
      activeState = shallowActiveState(active);
    }
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
