import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { statusDocsRepo } from "../docs-repo/DocsRepoManager";
import { renderHookLauncher } from "../hook/HookLauncher";
import { atomicWriteTextSync } from "../adapter/storage/AtomicWriter";
import { registerSharedDocumentScope, registeredSharedDocumentScopes } from "./DocumentScopeRegistry";
export { documentScopeRegistryPath, registeredSharedDocumentScopes } from "./DocumentScopeRegistry";
export type { SharedDocumentScope, SharedDocumentScopeRegistry } from "./DocumentScopeRegistry";

export type DocumentStoreMode = "project-local" | "shared";

export interface DocumentStoreConfig {
  readonly version: "1";
  readonly mode: DocumentStoreMode;
  /** Project-relative document root for project-local stores. */
  readonly root?: string;
  /** Explicit path inside a shared document Git repository. */
  readonly scopeRoot?: string;
  readonly scopeId?: string;
}

export interface DocumentStore {
  readonly mode: DocumentStoreMode;
  readonly root: string;
  readonly scopeRoot: string;
  readonly gitRoot: string;
  readonly scopeId: string;
  /** Shared stores without an explicit scope are legacy-only and cannot be scanned. */
  readonly scopeConfigured: boolean;
}

const CONFIG_PATH = ".openarch/document-store.json";
const LOCAL_ROOT = "docs/openarch";
const LOCAL_SCOPE_ID = "repository-local";
const STORE_META_DIR = ".openarch";
const RELATIONS_FILE = "document-relations.v1.json";

const resolvePath = (value: string, cwd: string): string => isAbsolute(value) ? resolve(value) : resolve(cwd, value);

const readStoreConfig = (cwd: string): DocumentStoreConfig | null => {
  try {
    const value = JSON.parse(readFileSync(resolvePath(CONFIG_PATH, cwd), "utf8")) as DocumentStoreConfig;
    if (value.version !== "1" || !["project-local", "shared"].includes(value.mode)) return null;
    if (value.mode === "project-local" && value.root !== undefined && !ensureInside(resolve(cwd), resolvePath(value.root, cwd))) return null;
    if (value.mode === "shared" && (!value.scopeRoot || isAbsolute(value.scopeRoot)
      || !value.scopeId || value.scopeId.includes("/") || value.scopeId.includes("\\"))) return null;
    return value;
  } catch {
    return null;
  }
};

const writeStoreConfig = (cwd: string, config: DocumentStoreConfig): void => {
  const path = resolvePath(CONFIG_PATH, cwd);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteTextSync(path, `${JSON.stringify(config, null, 2)}\n`);
};

const ensureInside = (root: string, child: string): boolean => {
  const rel = relative(root, child).replace(/\\/g, "/");
  return rel === "" || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel));
};

const ensureProjectLayout = (root: string): void => {
  for (const directory of ["decisions", "wisdom/patterns", "wisdom/anti_patterns", "debt"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  const metaDir = join(root, STORE_META_DIR);
  mkdirSync(metaDir, { recursive: true });
  const ignorePath = join(metaDir, ".gitignore");
  const ignored = ["document-index.v1.json", "document-index.v1.json.tmp-*", "governance-observations.v1.json"];
  const existingIgnored = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8").split(/\r?\n/).filter(Boolean) : [];
  const missingIgnored = ignored.filter((entry) => !existingIgnored.includes(entry));
  if (missingIgnored.length > 0) writeFileSync(ignorePath, `${[...existingIgnored, ...missingIgnored].join("\n")}\n`, "utf8");
  const relationsPath = join(root, RELATIONS_FILE);
  if (!existsSync(relationsPath)) writeFileSync(relationsPath, '{\n  "version": "1",\n  "relations": []\n}\n', "utf8");
  const capabilitiesPath = join(root, "CORE-CAPABILITIES.md");
  if (!existsSync(capabilitiesPath)) {
    writeFileSync(capabilitiesPath, "# 核心能力资产\n\n> 项目已实现、可复用能力的权威清单。\n\n| 能力 | 位置 | 说明 |\n|---|---|---|\n", "utf8");
  }
};

export const initializeProjectDocumentStore = (cwd: string): DocumentStore => {
  const root = resolvePath(LOCAL_ROOT, cwd);
  ensureProjectLayout(root);
  writeStoreConfig(cwd, { version: "1", mode: "project-local", root: LOCAL_ROOT, scopeId: LOCAL_SCOPE_ID });
  return { mode: "project-local", root, scopeRoot: root, gitRoot: cwd, scopeId: LOCAL_SCOPE_ID, scopeConfigured: true };
};

/** Attach an explicitly scoped external docs Git repository to this project. */
export const configureSharedDocumentStore = (cwd: string, scopeRoot: string, scopeId: string): DocumentStore | { error: string } => {
  const docs = statusDocsRepo(cwd);
  if (!docs.associated || !docs.config || !docs.symlinkValid) return { error: "共享文档库未关联或软链接失效" };
  if (!scopeId.trim() || scopeId.includes("/") || scopeId.includes("\\") || isAbsolute(scopeRoot)) return { error: "shared document scope 必须是非空稳定 ID 与相对路径" };
  const root = resolve(docs.config.target);
  const scopedRoot = resolve(root, scopeRoot);
  if (!ensureInside(root, scopedRoot)) return { error: "shared document scope 必须位于文档库根目录内" };
  const registryError = registerSharedDocumentScope(root, { id: scopeId, root: scopeRoot });
  if (registryError) return { error: registryError };
  mkdirSync(scopedRoot, { recursive: true });
  ensureProjectLayout(scopedRoot);
  writeStoreConfig(cwd, { version: "1", mode: "shared", scopeRoot, scopeId });
  return { mode: "shared", root, scopeRoot: scopedRoot, gitRoot: root, scopeId, scopeConfigured: true };
};

export const resolveDocumentStore = (cwd: string): DocumentStore | null => {
  const config = readStoreConfig(cwd);
  if (config?.mode === "project-local") {
    const root = resolvePath(config.root ?? LOCAL_ROOT, cwd);
    return { mode: "project-local", root, scopeRoot: root, gitRoot: cwd, scopeId: config.scopeId ?? LOCAL_SCOPE_ID, scopeConfigured: true };
  }
  const docs = statusDocsRepo(cwd);
  if (!docs.associated || !docs.config || !docs.symlinkValid) return null;
  const root = resolve(docs.config.target);
  if (config?.mode === "shared" && config.scopeRoot && config.scopeId) {
    const scopeRoot = resolve(root, config.scopeRoot);
    if (!ensureInside(root, scopeRoot)) return null;
    return { mode: "shared", root, scopeRoot, gitRoot: root, scopeId: config.scopeId, scopeConfigured: true };
  }
  // Legacy external docs remain writable, but their unscoped contents are not eligible for similarity analysis.
  return { mode: "shared", root, scopeRoot: root, gitRoot: root, scopeId: `legacy:${basename(root)}`, scopeConfigured: false };
};

/**
 * Resolve all registered scopes when invoked from a shared docs Git root.
 * A project invocation still resolves exactly its explicitly bound scope.
 */
export const resolveDocumentStores = (cwd: string): readonly DocumentStore[] => {
  const store = resolveDocumentStore(cwd);
  if (store) return [store];
  const root = resolve(cwd);
  const scopes = registeredSharedDocumentScopes(root);
  if (!scopes) return [];
  return scopes.map((scope) => ({
    mode: "shared" as const,
    root,
    scopeRoot: resolve(root, scope.root),
    gitRoot: root,
    scopeId: scope.id,
    scopeConfigured: true,
  }));
};

export const documentStoreConfigPath = (cwd: string): string => resolvePath(CONFIG_PATH, cwd);
/** Capability assets are owned by the explicitly resolved DocumentStore scope. */
export const capabilityAssetPath = (store: DocumentStore): string => join(store.scopeRoot, "CORE-CAPABILITIES.md");
export const documentRelationsPath = (store: DocumentStore): string => join(store.scopeRoot, RELATIONS_FILE);
export const documentIndexPath = (store: DocumentStore): string => join(store.scopeRoot, STORE_META_DIR, "document-index.v1.json");

export const installDocumentAdvisoryHook = (store: DocumentStore): "installed" | "updated" | "skipped" | "unavailable" => {
  const hookPath = join(store.gitRoot, ".git", "hooks", "pre-commit");
  if (!existsSync(join(store.gitRoot, ".git"))) return "unavailable";
  const marker = "# OpenArch document advisory hook";
  const content = `#!/bin/sh
${marker}
${renderHookLauncher("advisory", "OpenArch document advisory")}
"$OPENARCH_BIN" docs check --staged || true
`;
  const makeExecutable = (): void => {
    if (process.platform !== "win32") chmodSync(hookPath, 0o755);
  };
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf8");
    if (!existing.includes(marker)) return "skipped";
    writeFileSync(hookPath, content, "utf8");
    makeExecutable();
    return "updated";
  }
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, content, "utf8");
  makeExecutable();
  return "installed";
};
