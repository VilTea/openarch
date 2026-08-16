import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { load } from "js-yaml";
import { minimatch } from "minimatch";
import { toPosixPath } from "../infra/paths";
import { capabilityAssetPath, resolveDocumentStore } from "./DocumentStore";

export interface CapabilityDriftSignal {
  /** Declared watch patterns; empty means the project did not opt in. */
  readonly watch: readonly string[];
  /** Changed project-relative paths that match a watch pattern but are not the capability asset. */
  readonly matched: readonly string[];
  /** Invalid `governance.capability_watch` configuration (report-only, never a gate). */
  readonly error?: string;
}

interface DriftConfig {
  governance?: { capability_watch?: unknown };
}

const patternsOf = (value: unknown): { readonly patterns: readonly string[]; readonly error?: string } => {
  if (value === undefined) return { patterns: [] };
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    return { patterns: [], error: "governance.capability_watch 必须是 glob 字符串数组" };
  }
  return { patterns: value.map((entry) => entry.trim()) };
};

/**
 * Report-only drift signal: code surfaces listed in `governance.capability_watch`
 * changed, but the bound capability asset is not part of the same change set.
 * It never changes the check verdict; `docs check --changed <asset>` records the
 * maintenance observation once the asset has been updated.
 */
export const capabilityDriftSignal = (cwd: string, changedPaths: readonly string[]): CapabilityDriftSignal => {
  const configFile = resolve(cwd, ".openarch/config.yml");
  let configured: { readonly patterns: readonly string[]; readonly error?: string } = { patterns: [] };
  if (existsSync(configFile)) {
    try {
      const parsed = load(readFileSync(configFile, "utf8")) as DriftConfig | undefined;
      configured = patternsOf(parsed?.governance?.capability_watch);
    } catch {
      configured = { patterns: [], error: "capability_watch 配置无法解析（report-only）" };
    }
  }
  if (configured.error || configured.patterns.length === 0 || changedPaths.length === 0) {
    return { watch: configured.patterns, matched: [], ...(configured.error ? { error: configured.error } : {}) };
  }

  const store = resolveDocumentStore(cwd);
  const asset = store ? capabilityAssetPath(store) : null;
  const assetInProject = asset ? (() => {
    const rel = relative(cwd, asset);
    return !rel.startsWith("..") && !isAbsolute(rel) ? toPosixPath(rel) : undefined;
  })() : undefined;

  const matched = changedPaths
    .map((path) => toPosixPath(path))
    .filter((path) => path !== assetInProject)
    .filter((path) => configured.patterns.some((pattern) => minimatch(path, pattern, { dot: true })));
  return { watch: configured.patterns, matched };
};
