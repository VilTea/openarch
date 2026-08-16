import { governanceReadiness, MACHINE_CONTRACT_VERSIONS, projectGovernanceStatus, type BaselineGenerationDiagnostics, type GovernanceReadinessKind, type GovernanceReadinessReason } from "@openarch/core";
import { gitChangePathResult } from "../gitChangePaths";
import { type Locale, type MessageKey, message } from "../i18n";
import { isAnalyzableSourceFile, type CommandHandler } from "../runtime";
import { worktreeEvidenceState, type WorktreeEvidenceState } from "../semanticEvidence";
import { collectCoordinationContext, type CoordinationContextFact } from "../coordinationContext";

interface ChangeContext {
  readonly availability: "available" | "unavailable";
  readonly paths: number;
  readonly sourcePaths: number;
  readonly reason?: string;
  readonly pendingEvidence?: WorktreeEvidenceState;
}

interface PolicyPopulationContract {
  readonly id: string;
  readonly productionFiles: number;
  readonly calibration: "sealed" | "bootstrapped";
}

interface ArchitecturePolicyContract {
  readonly id: string;
  readonly mode: "observe" | "enforce";
  readonly languages: readonly string[];
  readonly rules: number;
}

interface ScanContract {
  readonly status: {
    readonly status: "running" | "completed" | "failed";
    readonly phase?: string;
    readonly completed?: number;
    readonly total?: number;
    readonly startedAt?: string;
    readonly updatedAt?: string;
    readonly nFiles?: number;
    readonly reason?: string;
  } | null;
  readonly exclusions: { readonly segments: readonly string[]; readonly directoryNames: readonly string[] };
}

interface ProjectContext {
  /** 规范自识别字段：所有机器契约载荷都在顶层带 schema（与 test/provider-list 一致）。 */
  readonly schema: typeof MACHINE_CONTRACT_VERSIONS.contextJson;
  /**
   * @deprecated v1 兼容别名；规范自识别字段是 schema。插件请读 schema；
   * context-json-v2 起将移除本字段。
   */
  readonly contract: { readonly id: "context-json"; readonly version: string };
  readonly configuration: "available" | "missing";
  /** 当前源码实时检测语言（去重排序；含 Vue/TS/JS 回退）。 */
  readonly languages: readonly string[];
  readonly baseline: {
    readonly available: boolean;
    readonly files: number;
    readonly scope: "compatible" | "different" | "partial" | "unknown";
    readonly freshness: "current" | "stale" | "unknown";
    readonly scanAt?: string;
    readonly languages?: readonly string[];
    readonly snapshotSha256?: string;
    readonly metricContractVersion?: string;
    readonly policyPopulations?: readonly PolicyPopulationContract[];
    readonly generation?: BaselineGenerationDiagnostics;
  };
  readonly architecturePolicy: {
    readonly state: "configured" | "unconfigured" | "unavailable";
    readonly declaredRules?: number;
    readonly policies?: readonly ArchitecturePolicyContract[];
    readonly reason?: { readonly code: MessageKey; readonly params: Readonly<Record<string, string>> };
  };
  readonly changes: { readonly worktree: ChangeContext; readonly staged: ChangeContext };
  readonly readiness: readonly { readonly id: string; readonly state: string; readonly kind: GovernanceReadinessKind; readonly reason: GovernanceReadinessReason }[];
  readonly scan: ScanContract;
  readonly coordination?: CoordinationContextFact;
}

const changeContext = (cwd: string, source: "worktree" | "staged"): ChangeContext => {
  const result = gitChangePathResult(cwd, source);
  if (result.availability === "unavailable") return { availability: "unavailable", paths: 0, sourcePaths: 0, reason: result.reason };
  const paths = result.paths;
  const sourcePaths = paths.filter((path) => isAnalyzableSourceFile(path, cwd, "change-evidence"));
  return {
    availability: "available",
    paths: paths.length,
    sourcePaths: sourcePaths.length,
    ...(source === "worktree" && sourcePaths.length > 0
      ? { pendingEvidence: worktreeEvidenceState(cwd, sourcePaths) }
      : {}),
  };
};

const collectContext = (cwd: string): ProjectContext => {
  const project = projectGovernanceStatus(cwd);
  return {
    schema: MACHINE_CONTRACT_VERSIONS.contextJson,
    contract: { id: "context-json", version: MACHINE_CONTRACT_VERSIONS.contextJson },
    configuration: project.configured ? "available" : "missing",
    languages: project.languages,
    baseline: {
      available: project.baseline.exists, files: project.baseline.nFiles,
      scope: project.baseline.scope, freshness: project.baseline.freshness,
      ...(project.baseline.scanAt ? { scanAt: project.baseline.scanAt } : {}),
      ...(project.baseline.languages ? { languages: project.baseline.languages } : {}),
      ...(project.baseline.snapshotSha256 ? { snapshotSha256: project.baseline.snapshotSha256 } : {}),
      ...(project.baseline.metricContractVersion ? { metricContractVersion: project.baseline.metricContractVersion } : {}),
      ...(project.baseline.policyPopulations ? { policyPopulations: project.baseline.policyPopulations } : {}),
      ...(project.baseline.generation ? { generation: project.baseline.generation } : {}),
    },
    architecturePolicy: project.architecturePolicy,
    changes: { worktree: changeContext(cwd, "worktree"), staged: changeContext(cwd, "staged") },
    readiness: governanceReadiness(cwd).items,
    scan: project.scan,
  };
};


export const readinessMessage = (locale: Locale, reason: GovernanceReadinessReason): string =>
  message(locale, reason.code as MessageKey, reason.params);

const printContext = (context: ProjectContext, locale: Locale): void => {
  console.log(message(locale, "context.heading"));
  console.log(message(locale, "context.configuration", { state: message(locale, `context.${context.configuration}` as MessageKey) }));
  console.log(message(locale, "context.languages", { languages: context.languages.length > 0 ? context.languages.join(", ") : "unknown" }));
  console.log(message(locale, context.baseline.available ? "context.baselineAvailable" : "context.baselineMissing", {
    files: context.baseline.files,
    scope: message(locale, `context.baselineScope.${context.baseline.scope}` as MessageKey),
    freshness: message(locale, `context.baselineFreshness.${context.baseline.freshness}` as MessageKey),
    scanAt: context.baseline.scanAt ? message(locale, "context.baselineScanAt", { at: context.baseline.scanAt }) : "",
  }));
  if (context.baseline.generation) {
    console.log(message(locale, "context.baselineGeneration", {
      active: context.baseline.generation.active,
      readable: context.baseline.generation.readable,
      transient: context.baseline.generation.artifacts.length,
    }));
  }
  if (context.baseline.policyPopulations && context.baseline.policyPopulations.length > 0) {
    console.log(message(locale, "context.policyPopulations"));
    for (const policy of context.baseline.policyPopulations) {
      console.log(message(locale, "context.policyPopulationEntry", {
        id: policy.id,
        productionFiles: policy.productionFiles,
        calibration: policy.calibration,
      }));
    }
  }
  console.log(message(locale, "context.architecturePolicy", {
    state: context.architecturePolicy.state.toUpperCase(),
    detail: context.architecturePolicy.declaredRules !== undefined
      ? message(locale, "context.declaredRules", { count: context.architecturePolicy.declaredRules })
      : context.architecturePolicy.reason ? ` (${message(locale, context.architecturePolicy.reason.code, {
        ...context.architecturePolicy.reason.params,
        detail: context.architecturePolicy.reason.params.detail ? `: ${context.architecturePolicy.reason.params.detail}` : "",
      })})` : "",
  }));
  if (context.architecturePolicy.policies && context.architecturePolicy.policies.length > 0) {
    console.log(message(locale, "context.architecturePolicies", {
      policies: context.architecturePolicy.policies.map((policy) => `${policy.id}(${policy.mode}, ${policy.rules} rules)`).join(", "),
    }));
  }
  console.log(message(locale, "context.worktree", {
    paths: context.changes.worktree.paths,
    sources: context.changes.worktree.sourcePaths,
    pending: context.changes.worktree.pendingEvidence
      ? message(locale, "context.pending", { state: message(locale, `evidence.${context.changes.worktree.pendingEvidence}` as MessageKey) }) : "",
  }));
  console.log(message(locale, "context.staged", { paths: context.changes.staged.paths, sources: context.changes.staged.sourcePaths }));
  if (context.changes.worktree.availability === "unavailable" || context.changes.staged.availability === "unavailable") {
    console.log(message(locale, "context.gitUnavailable"));
  }
  if (context.scan.status) {
    console.log(message(locale, "context.scanStatus", {
      status: context.scan.status.status.toUpperCase(),
      completed: context.scan.status.completed ?? "?",
      total: context.scan.status.total ?? "?",
      phase: context.scan.status.phase ?? "unknown",
    }));
    if (context.scan.status.reason) console.log(message(locale, "context.scanReason", { reason: context.scan.status.reason }));
  } else {
    console.log(message(locale, "context.scanStatusNone"));
  }
  console.log(message(locale, "context.scanExclusions", { directories: context.scan.exclusions.directoryNames.join(", ") }));
  console.log(message(locale, "context.readiness"));
  for (const item of context.readiness) console.log(`- [${item.state.toUpperCase()}] ${item.id}: ${readinessMessage(locale, item.reason)}`);
  console.log("---");
  console.log(message(locale, "context.footer"));
};

/** Read-only project facts for Agent reasoning; it deliberately performs no workflow routing. */
export const contextCommand: CommandHandler = async (args, commandContext) => {
  if (args.some((arg) => arg !== "--json" && arg !== "--remote")) {
    console.error(message(commandContext.locale, "context.usage"));
    return 3;
  }
  const localContext = collectContext(commandContext.cwd);
  let coordination: ProjectContext["coordination"];
  if (args.includes("--remote")) {
    coordination = await collectCoordinationContext(commandContext.cwd);
  }
  const context: ProjectContext = coordination ? { ...localContext, coordination } : localContext;
  if (args.includes("--json")) console.log(JSON.stringify(context, null, 2));
  else printContext(context, commandContext.locale);
  return 0;
};
