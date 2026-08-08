import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { statusDocsRepo } from "../docs-repo/DocsRepoManager";
import { capabilityAssetPath, registeredSharedDocumentScopes, resolveDocumentStore, type DocumentStore } from "../document-store/DocumentStore";
import { contentSha256 } from "../document-store/DocumentFingerprint";
import { readGovernanceObservation } from "../document-store/GovernanceObservation";
import { hookExecutable, hookExecutableAvailable } from "../hook/HookLauncher";
import { readCoordinationConfig } from "./coordinationConfig";

export type GovernanceReadinessState = "ready" | "not_configured" | "unavailable" | "not_observed";

export type GovernanceReadinessReasonCode =
  | "readiness.capabilityAssetMissing"
  | "readiness.capabilityAsset"
  | "readiness.capabilityMaintenanceChecked"
  | "readiness.capabilityMaintenanceUnobserved"
  | "readiness.documentHookMissing"
  | "readiness.documentHookInstalled"
  | "readiness.documentHookStale"
  | "readiness.codeHookMissing"
  | "readiness.codeHookExternal"
  | "readiness.codeHookStale"
  | "readiness.codeHookInstalled"
  | "readiness.hookRuntimeAvailable"
  | "readiness.hookRuntimeMissing"
  | "readiness.documentStoreMissing"
  | "readiness.documentStoreProject"
  | "readiness.documentStoreShared"
  | "readiness.documentStoreSharedUnavailable"
  | "readiness.documentScopeMissing"
  | "readiness.documentScopeRegistered"
  | "readiness.documentScopeUnregistered"
  | "readiness.documentSimilarityChecked"
  | "readiness.documentSimilarityUnobserved"
  | "readiness.coordinationNotConfigured"
  | "readiness.coordinationConfigured"
  | "readiness.coordinationInvalid";

export interface GovernanceReadinessReason {
  readonly code: GovernanceReadinessReasonCode;
  readonly params: Readonly<Record<string, string>>;
}

export interface GovernanceReadinessItem {
  readonly id: string;
  readonly state: GovernanceReadinessState;
  readonly reason: GovernanceReadinessReason;
}

export interface GovernanceReadinessReport {
  readonly items: readonly GovernanceReadinessItem[];
}

const item = (
  id: string,
  state: GovernanceReadinessState,
  code: GovernanceReadinessReasonCode,
  params: Readonly<Record<string, string>> = {},
): GovernanceReadinessItem => ({ id, state, reason: { code, params } });

const capabilityItems = (store: DocumentStore): readonly GovernanceReadinessItem[] => {
  const path = capabilityAssetPath(store);
  if (!existsSync(path)) return [item("capability-asset", "unavailable", "readiness.capabilityAssetMissing", { path })];
  const currentFingerprint = contentSha256(readFileSync(path, "utf8"));
  const observation = readGovernanceObservation(store.scopeRoot, "capability-maintenance");
  const maintained = observation?.inputFingerprint === currentFingerprint;
  return [
    item("capability-asset", "ready", "readiness.capabilityAsset", { path }),
    maintained
      ? item("capability-maintenance", "ready", "readiness.capabilityMaintenanceChecked", { at: observation.at })
      : item("capability-maintenance", "not_observed", "readiness.capabilityMaintenanceUnobserved", { path }),
  ];
};

const sharedHookState = (gitRoot: string): GovernanceReadinessItem => {
  const hook = join(gitRoot, ".git", "hooks", "pre-commit");
  if (!existsSync(hook)) return item("document-hook", "unavailable", "readiness.documentHookMissing");
  const content = readFileSync(hook, "utf8");
  return content.includes("# OpenArch document advisory hook")
    && content.includes("OPENARCH_BIN")
    ? item("document-hook", "ready", "readiness.documentHookInstalled")
    : item("document-hook", "unavailable", "readiness.documentHookStale");
};

const codeHookItems = (cwd: string): readonly GovernanceReadinessItem[] => {
  const hook = join(cwd, ".git", "hooks", "pre-commit");
  if (!existsSync(hook)) return [item("code-hook", "not_configured", "readiness.codeHookMissing")];
  const content = readFileSync(hook, "utf8");
  if (!content.includes("# OpenArch pre-commit hook")) return [item("code-hook", "unavailable", "readiness.codeHookExternal")];
  if (!content.includes("OPENARCH_BIN")) return [item("code-hook", "unavailable", "readiness.codeHookStale")];
  const executable = hookExecutable();
  return [
    item("code-hook", "ready", "readiness.codeHookInstalled"),
    hookExecutableAvailable(executable)
      ? item("code-hook-runtime", "ready", "readiness.hookRuntimeAvailable", { executable })
      : item("code-hook-runtime", "unavailable", "readiness.hookRuntimeMissing", { executable }),
  ];
};

const coordinationItem = (cwd: string): GovernanceReadinessItem => {
  const config = readCoordinationConfig(cwd);
  if (config.state === "configured") return item("coordination-service", "ready", "readiness.coordinationConfigured", { url: config.config.url });
  if (config.state === "invalid") return item("coordination-service", "unavailable", "readiness.coordinationInvalid", { path: config.path, reason: config.reason });
  return item("coordination-service", "not_configured", "readiness.coordinationNotConfigured");
};

/**
 * Report-only operational evidence for governance features with cross-root execution.
 * More checks can join this stable item contract without changing gate semantics.
 */
export const governanceReadiness = (cwd: string = process.cwd()): GovernanceReadinessReport => {
  const codeItems = codeHookItems(cwd);
  const coordinator = coordinationItem(cwd);
  const store = resolveDocumentStore(cwd);
  if (!store) return { items: [...codeItems, coordinator, item("document-store", "not_configured", "readiness.documentStoreMissing")] };
  if (store.mode === "project-local") {
    const observation = readGovernanceObservation(store.scopeRoot, "document-similarity");
    return {
      items: [
        ...codeItems, coordinator,
        item("document-store", "ready", "readiness.documentStoreProject", { root: store.scopeRoot }),
        ...capabilityItems(store),
        observation
          ? item("document-similarity", "ready", "readiness.documentSimilarityChecked", { at: observation.at })
          : item("document-similarity", "not_observed", "readiness.documentSimilarityUnobserved"),
      ],
    };
  }
  if (!store.scopeConfigured) return { items: [...codeItems, coordinator, item("document-store", "unavailable", "readiness.documentScopeMissing")] };

  const docs = statusDocsRepo(cwd);
  const scopePath = relative(store.root, store.scopeRoot).replace(/\\/g, "/");
  const scopes = registeredSharedDocumentScopes(store.root);
  const registered = scopes?.some((scope) => scope.id === store.scopeId && scope.root === scopePath) ?? false;
  const executable = hookExecutable();
  const observation = readGovernanceObservation(store.scopeRoot, "document-similarity");
  return {
    items: [
      ...codeItems, coordinator,
      docs.associated && docs.symlinkValid
        ? item("document-store", "ready", "readiness.documentStoreShared", { root: store.root })
        : item("document-store", "unavailable", "readiness.documentStoreSharedUnavailable"),
      registered
        ? item("document-scope", "ready", "readiness.documentScopeRegistered", { scope: store.scopeId ?? "" })
        : item("document-scope", "unavailable", "readiness.documentScopeUnregistered"),
      ...capabilityItems(store),
      sharedHookState(store.gitRoot),
      hookExecutableAvailable(executable)
        ? item("document-hook-runtime", "ready", "readiness.hookRuntimeAvailable", { executable })
        : item("document-hook-runtime", "unavailable", "readiness.hookRuntimeMissing", { executable }),
      observation
        ? item("document-similarity", "ready", "readiness.documentSimilarityChecked", { at: observation.at })
        : item("document-similarity", "not_observed", "readiness.documentSimilarityUnobserved"),
    ],
  };
};
