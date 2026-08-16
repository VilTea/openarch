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
import { SCAN_EXCLUDED_DIRECTORY_NAMES, SCAN_EXCLUDED_SEGMENTS } from "../infra/scanExclusions";

export interface StatusReport {
  readonly baseline: { exists: boolean; nFiles: number };
  readonly docsRepo: { associated: boolean; type?: string; behind?: number; ahead?: number; symlinkValid: boolean };
  readonly documentStore: { configured: boolean; mode?: string; root?: string; scopeConfigured?: boolean };
}

/** 每策略生产文件数与校准来源（scan 时持久化的人口事实，小样本提示用）。 */
export interface PolicyPopulationFact {
  readonly id: string;
  readonly productionFiles: number;
  readonly calibration: "sealed" | "bootstrapped";
}

export interface ArchitecturePolicyFact {
  readonly id: string;
  readonly mode: "observe" | "enforce";
  readonly languages: readonly string[];
  readonly rules: number;
}

/** .openarch/scan-status.json 的只读投影（含失败原因——解析失败即在此可见）。 */
export interface ScanStatusFact {
  readonly status: "running" | "completed" | "failed";
  readonly phase?: string;
  readonly completed?: number;
  readonly total?: number;
  readonly startedAt?: string;
  readonly updatedAt?: string;
  readonly nFiles?: number;
  readonly reason?: string;
}

export interface ProjectGovernanceStatus {
  readonly configured: boolean;
  /** 当前源码实时检测语言（含 Vue/TS/JS 回退），与 baseline 记录的 scan 时语言分开。 */
  readonly languages: readonly string[];
  readonly baseline: {
    readonly exists: boolean;
    readonly nFiles: number;
    readonly scope: "compatible" | "different" | "partial" | "unknown";
    readonly freshness: "current" | "stale" | "unknown";
    readonly scanAt?: string;
    /** Scan 时记录的项目语言。 */
    readonly languages?: readonly string[];
    /** Baseline 快照身份与指标合同版本（缺失时 fail-closed 为 unknown，不猜）。 */
    readonly snapshotSha256?: string;
    readonly metricContractVersion?: string;
    /** 每策略生产文件数与校准来源（无策略或无人口时缺省）。 */
    readonly policyPopulations?: readonly PolicyPopulationFact[];
    /** Present when canonical or temporary generations need investigation. */
    readonly generation?: BaselineGenerationDiagnostics;
  };
  readonly architecturePolicy: {
    readonly state: "configured" | "unconfigured" | "unavailable";
    readonly declaredRules?: number;
    readonly policies?: readonly ArchitecturePolicyFact[];
    readonly reason?: {
      readonly code: "architecturePolicy.configMissing" | "architecturePolicy.configRootInvalid" | "architecturePolicy.configReadFailed";
      readonly params: Readonly<Record<string, string>>;
    };
  };
  /** scan 状态与固定扫描排除边界（产品卫生边界，非项目配置）。 */
  readonly scan: {
    readonly status: ScanStatusFact | null;
    readonly exclusions: { readonly segments: readonly string[]; readonly directoryNames: readonly string[] };
  };
}

const architecturePolicyStatus = (config: string, configured: boolean): ProjectGovernanceStatus["architecturePolicy"] => {
  if (!configured) return { state: "unavailable", reason: { code: "architecturePolicy.configMissing", params: {} } };
  try {
    const parsed = load(readFileSync(config, "utf8")) as { rules_warn?: unknown; rules_block?: unknown; structural_policies?: unknown } | undefined;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "unavailable", reason: { code: "architecturePolicy.configRootInvalid", params: {} } };
    const policyRules = (policy: unknown): number => {
      if (!policy || typeof policy !== "object") return 0;
      const warn = Array.isArray((policy as { rules_warn?: unknown }).rules_warn) ? (policy as { rules_warn: unknown[] }).rules_warn.length : 0;
      const block = Array.isArray((policy as { rules_block?: unknown }).rules_block) ? (policy as { rules_block: unknown[] }).rules_block.length : 0;
      return warn + block;
    };
    const policies: ArchitecturePolicyFact[] = Array.isArray(parsed.structural_policies)
      ? parsed.structural_policies.flatMap((raw) => {
          if (!raw || typeof raw !== "object" || typeof (raw as { id?: unknown }).id !== "string") return [];
          const policy = raw as { id: string; mode?: unknown; languages?: unknown };
          return [{
            id: policy.id,
            mode: policy.mode === "enforce" ? "enforce" as const : "observe" as const,
            languages: Array.isArray(policy.languages) ? policy.languages.filter((language): language is string => typeof language === "string") : [],
            rules: policyRules(policy),
          }];
        })
      : [];
    const declaredRules = policies.length > 0
      ? policies.reduce((total, policy) => total + policy.rules, 0)
      : (Array.isArray(parsed.rules_warn) ? parsed.rules_warn.length : 0) + (Array.isArray(parsed.rules_block) ? parsed.rules_block.length : 0);
    return declaredRules === 0
      ? { state: "unconfigured", declaredRules }
      : { state: "configured", declaredRules, ...(policies.length > 0 ? { policies } : {}) };
  } catch (error) {
    return { state: "unavailable", reason: { code: "architecturePolicy.configReadFailed", params: { detail: error instanceof Error ? error.message : "" } } };
  }
};

const normalizedLanguages = (languages: readonly string[]): readonly string[] => [...new Set(languages)].sort();

/** scan-status.json 是 scan 进行中/失败事实的只读载体；损坏或缺省时返回 null（不是 clean）。 */
const readScanStatus = (root: string): ScanStatusFact | null => {
  try {
    const parsed = JSON.parse(readFileSync(resolve(root, "scan-status.json"), "utf8")) as Partial<ScanStatusFact> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.status !== "running" && parsed.status !== "completed" && parsed.status !== "failed") return null;
    return {
      status: parsed.status,
      ...(typeof parsed.phase === "string" ? { phase: parsed.phase } : {}),
      ...(typeof parsed.completed === "number" ? { completed: parsed.completed } : {}),
      ...(typeof parsed.total === "number" ? { total: parsed.total } : {}),
      ...(typeof parsed.startedAt === "string" ? { startedAt: parsed.startedAt } : {}),
      ...(typeof parsed.updatedAt === "string" ? { updatedAt: parsed.updatedAt } : {}),
      ...(typeof parsed.nFiles === "number" ? { nFiles: parsed.nFiles } : {}),
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
    };
  } catch {
    return null;
  }
};

/** Minimal local project facts. It deliberately does not inspect docs remotes or infer a workflow. */
export const projectGovernanceStatus = (cwd: string = process.cwd()): ProjectGovernanceStatus => {
  const base = openarchBase();
  const root = isAbsolute(base) ? base : resolve(cwd, base);
  const indexPath = resolve(root, "baseline", "_index.json");
  const generation = inspectBaselineGenerations(root, Date.now(), { deep: false });
  // Match readableBaselineDirFor: the newest valid backup is the recovery candidate.
  const readableBackup = generation.artifacts
    .filter((artifact) => artifact.kind === "backup" && artifact.state === "valid")
    .sort((left, right) => right.path.localeCompare(left.path))[0];
  const readableIndexPath = generation.readable === "backup" && readableBackup
    ? resolve(readableBackup.path, "_index.json")
    : indexPath;
  const resolvedConfigPath = isAbsolute(configPath()) ? configPath() : resolve(root, "config.yml");
  const liveLanguages = readProjectLanguages(cwd);
  let baseline: ProjectGovernanceStatus["baseline"] = { exists: false, nFiles: 0, scope: "unknown", freshness: "unknown" };
  if (existsSync(readableIndexPath)) {
    try {
      const idx = JSON.parse(readFileSync(readableIndexPath, "utf8"));
      const meta = idx.meta as {
        nFiles?: unknown;
        scanAt?: unknown;
        analysisScope?: { fingerprint?: unknown; complete?: unknown };
        sourceSnapshotSha256?: unknown;
        languages?: unknown;
        snapshotSha256?: unknown;
        metricContractVersion?: unknown;
        policyCalibrations?: Readonly<Record<string, { gate?: unknown }>>;
        policyPopulations?: Readonly<Record<string, unknown>>;
      } | undefined;
      const currentScope = createAnalysisScope(liveLanguages, readProjectFileKindRules(cwd));
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
      const policyPopulations = Object.entries(meta?.policyPopulations ?? {})
        .filter(([id, count]) => typeof id === "string" && typeof count === "number")
        .map(([id, count]) => ({
          id,
          productionFiles: count as number,
          calibration: meta?.policyCalibrations?.[id]?.gate ? "sealed" as const : "bootstrapped" as const,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
      baseline = {
        exists: true,
        nFiles: typeof meta?.nFiles === "number" ? meta.nFiles : 0,
        scope,
        freshness,
        ...(typeof meta?.scanAt === "string" ? { scanAt: meta.scanAt } : {}),
        ...(Array.isArray(meta?.languages) ? { languages: meta.languages.filter((language): language is string => typeof language === "string") } : {}),
        ...(typeof meta?.snapshotSha256 === "string" ? { snapshotSha256: meta.snapshotSha256 } : {}),
        ...(typeof meta?.metricContractVersion === "string" ? { metricContractVersion: meta.metricContractVersion } : {}),
        ...(policyPopulations.length > 0 ? { policyPopulations } : {}),
        ...(generation.active !== "valid" || generation.artifacts.length > 0 ? { generation } : {}),
      };
    } catch { /* malformed baseline remains unavailable */ }
  }

  const configured = existsSync(resolvedConfigPath);
  return {
    configured,
    languages: normalizedLanguages(liveLanguages),
    baseline,
    architecturePolicy: architecturePolicyStatus(resolvedConfigPath, configured),
    scan: {
      status: readScanStatus(root),
      exclusions: {
        segments: [...SCAN_EXCLUDED_SEGMENTS],
        directoryNames: [...SCAN_EXCLUDED_DIRECTORY_NAMES].sort(),
      },
    },
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
