import { governanceReadiness, projectGovernanceStatus, type BaselineGenerationDiagnostics, type GovernanceReadinessReason } from "@openarch/core";
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

interface ProjectContext {
  readonly configuration: "available" | "missing";
  readonly baseline: {
    readonly available: boolean;
    readonly files: number;
    readonly scope: "compatible" | "different" | "partial" | "unknown";
    readonly freshness: "current" | "stale" | "unknown";
    readonly scanAt?: string;
    readonly generation?: BaselineGenerationDiagnostics;
  };
  readonly architecturePolicy: {
    readonly state: "configured" | "unconfigured" | "unavailable";
    readonly declaredRules?: number;
    readonly reason?: { readonly code: MessageKey; readonly params: Readonly<Record<string, string>> };
  };
  readonly changes: { readonly worktree: ChangeContext; readonly staged: ChangeContext };
  readonly readiness: readonly { readonly id: string; readonly state: string; readonly reason: GovernanceReadinessReason }[];
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
    configuration: project.configured ? "available" : "missing",
    baseline: {
      available: project.baseline.exists, files: project.baseline.nFiles,
      scope: project.baseline.scope, freshness: project.baseline.freshness,
      ...(project.baseline.scanAt ? { scanAt: project.baseline.scanAt } : {}),
      ...(project.baseline.generation ? { generation: project.baseline.generation } : {}),
    },
    architecturePolicy: project.architecturePolicy,
    changes: { worktree: changeContext(cwd, "worktree"), staged: changeContext(cwd, "staged") },
    readiness: governanceReadiness(cwd).items,
  };
};


export const readinessMessage = (locale: Locale, reason: GovernanceReadinessReason): string =>
  message(locale, reason.code as MessageKey, reason.params);

const printContext = (context: ProjectContext, locale: Locale): void => {
  console.log(message(locale, "context.heading"));
  console.log(message(locale, "context.configuration", { state: message(locale, `context.${context.configuration}` as MessageKey) }));
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
  console.log(message(locale, "context.architecturePolicy", {
    state: context.architecturePolicy.state.toUpperCase(),
    detail: context.architecturePolicy.declaredRules !== undefined
      ? message(locale, "context.declaredRules", { count: context.architecturePolicy.declaredRules })
      : context.architecturePolicy.reason ? ` (${message(locale, context.architecturePolicy.reason.code, {
        ...context.architecturePolicy.reason.params,
        detail: context.architecturePolicy.reason.params.detail ? `: ${context.architecturePolicy.reason.params.detail}` : "",
      })})` : "",
  }));
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
