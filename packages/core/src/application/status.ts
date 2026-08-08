// packages/core/src/application/status.ts
//
// status use case：OpenArch 自身状态报告。
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { load } from "js-yaml";
import { statusDocsRepo, checkSyncStatus } from "../docs-repo/DocsRepoManager";
import { configPath, openarchBase } from "../infra/paths";
import { resolveDocumentStore } from "../document-store/DocumentStore";
import { createAnalysisScope } from "../domain/analysisScope";
import { listProjectSourceFiles, readProjectFileKindRules, readProjectLanguages, sourceSnapshotSha256 } from "../projectFiles";
import { inspectBaselineGenerations, type BaselineGenerationDiagnostics } from "../adapter/storage/BaselineGenerationDiagnostics";

export interface StatusReport {
  readonly baseline: { exists: boolean; nFiles: number };
  readonly docsRepo: { associated: boolean; type?: string; behind?: number; ahead?: number; symlinkValid: boolean };
  readonly documentStore: { configured: boolean; mode?: string; root?: string; scopeConfigured?: boolean };
}

export interface ProjectGovernanceStatus {
  readonly configured: boolean;
  readonly baseline: {
    readonly exists: boolean;
    readonly nFiles: number;
    readonly scope: "compatible" | "different" | "partial" | "unknown";
    readonly freshness: "current" | "stale" | "unknown";
    readonly scanAt?: string;
    /** Present when canonical or temporary generations need investigation. */
    readonly generation?: BaselineGenerationDiagnostics;
  };
  readonly architecturePolicy: {
    readonly state: "configured" | "unconfigured" | "unavailable";
    readonly declaredRules?: number;
    readonly reason?: {
      readonly code: "architecturePolicy.configMissing" | "architecturePolicy.configRootInvalid" | "architecturePolicy.configReadFailed";
      readonly params: Readonly<Record<string, string>>;
    };
  };
}

const architecturePolicyStatus = (config: string, configured: boolean): ProjectGovernanceStatus["architecturePolicy"] => {
  if (!configured) return { state: "unavailable", reason: { code: "architecturePolicy.configMissing", params: {} } };
  try {
    const parsed = load(readFileSync(config, "utf8")) as { rules_warn?: unknown; rules_block?: unknown; structural_policies?: unknown } | undefined;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "unavailable", reason: { code: "architecturePolicy.configRootInvalid", params: {} } };
    const declaredRules = Array.isArray(parsed.structural_policies)
      ? parsed.structural_policies.reduce((total, policy) => total
        + (policy && typeof policy === "object" && Array.isArray((policy as { rules_warn?: unknown }).rules_warn) ? (policy as { rules_warn: unknown[] }).rules_warn.length : 0)
        + (policy && typeof policy === "object" && Array.isArray((policy as { rules_block?: unknown }).rules_block) ? (policy as { rules_block: unknown[] }).rules_block.length : 0), 0)
      : (Array.isArray(parsed.rules_warn) ? parsed.rules_warn.length : 0) + (Array.isArray(parsed.rules_block) ? parsed.rules_block.length : 0);
    return declaredRules === 0 ? { state: "unconfigured", declaredRules } : { state: "configured", declaredRules };
  } catch (error) {
    return { state: "unavailable", reason: { code: "architecturePolicy.configReadFailed", params: { detail: error instanceof Error ? error.message : "" } } };
  }
};

/** Minimal local project facts. It deliberately does not inspect docs remotes or infer a workflow. */
export const projectGovernanceStatus = (cwd: string = process.cwd()): ProjectGovernanceStatus => {
  const base = openarchBase();
  const root = isAbsolute(base) ? base : resolve(cwd, base);
  const indexPath = resolve(root, "baseline", "_index.json");
  const generation = inspectBaselineGenerations(root);
  // Match readableBaselineDirFor: the newest valid backup is the recovery candidate.
  const readableBackup = generation.artifacts
    .filter((artifact) => artifact.kind === "backup" && artifact.state === "valid")
    .sort((left, right) => right.path.localeCompare(left.path))[0];
  const readableIndexPath = generation.readable === "backup" && readableBackup
    ? resolve(readableBackup.path, "_index.json")
    : indexPath;
  const resolvedConfigPath = isAbsolute(configPath()) ? configPath() : resolve(root, "config.yml");
  let baseline: ProjectGovernanceStatus["baseline"] = { exists: false, nFiles: 0, scope: "unknown", freshness: "unknown" };
  if (existsSync(readableIndexPath)) {
    try {
      const idx = JSON.parse(readFileSync(readableIndexPath, "utf8"));
      const meta = idx.meta as {
        nFiles?: unknown;
        scanAt?: unknown;
        analysisScope?: { fingerprint?: unknown; complete?: unknown };
        sourceSnapshotSha256?: unknown;
      } | undefined;
      const currentScope = createAnalysisScope(readProjectLanguages(cwd), readProjectFileKindRules(cwd));
      const complete = meta?.analysisScope?.complete === true;
      const scope = !meta?.analysisScope || typeof meta.analysisScope.fingerprint !== "string"
        ? "unknown"
        : !complete ? "partial"
          : meta.analysisScope.fingerprint === currentScope.fingerprint ? "compatible" : "different";
      const currentSource = scope === "compatible"
        ? sourceSnapshotSha256(listProjectSourceFiles({ cwd, population: "observed" }), cwd)
        : undefined;
      const freshness = scope === "compatible" && typeof meta?.sourceSnapshotSha256 === "string" && currentSource !== undefined
        ? meta.sourceSnapshotSha256 === currentSource ? "current" : "stale"
        : "unknown";
      baseline = {
        exists: true,
        nFiles: typeof meta?.nFiles === "number" ? meta.nFiles : 0,
        scope,
        freshness,
        ...(typeof meta?.scanAt === "string" ? { scanAt: meta.scanAt } : {}),
        ...(generation.active !== "valid" || generation.artifacts.length > 0 ? { generation } : {}),
      };
    } catch { /* malformed baseline remains unavailable */ }
  }

  const configured = existsSync(resolvedConfigPath);
  return {
    configured,
    baseline,
    architecturePolicy: architecturePolicyStatus(resolvedConfigPath, configured),
  };
};

export const status = (cwd: string = process.cwd()): StatusReport => {
  const project = projectGovernanceStatus(cwd);

  const docs = statusDocsRepo(cwd);
  const sync = docs.associated && docs.config?.type === "git-clone" ? checkSyncStatus(cwd) : null;
  const store = resolveDocumentStore(cwd);

  return {
    baseline: project.baseline,
    docsRepo: {
      associated: docs.associated,
      type: docs.config?.type,
      behind: sync?.behind,
      ahead: sync?.ahead,
      symlinkValid: docs.symlinkValid,
    },
    documentStore: store
      ? { configured: true, mode: store.mode, root: store.root, scopeConfigured: store.scopeConfigured }
      : { configured: false },
  };
};
