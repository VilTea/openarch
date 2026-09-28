import { isAbsolute, relative } from "node:path";
import { minimatch } from "minimatch";
import { toPosixPath } from "../infra/paths";
import { projectConfigPath, readProjectConfig } from "../projectFiles";
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
  // 读取走 `readProjectConfig`（config.yml 唯一读取权威，D-G13）：不再 `existsSync` + 自己 `load`。
  // report-only 语义不变（读不出来 ⇒ error 字段 + 不匹配任何路径），但原因带上解析错误原文。
  const read = readProjectConfig(projectConfigPath(cwd));
  let configured: { readonly patterns: readonly string[]; readonly error?: string } = { patterns: [] };
  if (read.status === "invalid") {
    configured = { patterns: [], error: `capability_watch 配置无法解析（report-only）：${read.error}` };
  } else if (read.status === "ok") {
    configured = patternsOf((read.value as DriftConfig | undefined)?.governance?.capability_watch);
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
