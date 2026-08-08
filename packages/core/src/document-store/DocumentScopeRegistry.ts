import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface SharedDocumentScope {
  readonly id: string;
  readonly root: string;
}

export interface SharedDocumentScopeRegistry {
  readonly version: "1";
  readonly scopes: readonly SharedDocumentScope[];
}

const REGISTRY_PATH = ".openarch/document-scopes.v1.json";

const ensureInside = (root: string, child: string): boolean => {
  const rel = relative(root, child).replace(/\\/g, "/");
  return rel === "" || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel));
};

const validScope = (root: string, scope: SharedDocumentScope): boolean =>
  typeof scope.id === "string" && scope.id.trim().length > 0
  && typeof scope.root === "string" && scope.root.trim().length > 0
  && !isAbsolute(scope.root) && ensureInside(root, resolve(root, scope.root));

const readRegistry = (root: string): SharedDocumentScopeRegistry | null => {
  try {
    const value = JSON.parse(readFileSync(documentScopeRegistryPath(root), "utf8")) as SharedDocumentScopeRegistry;
    if (value.version !== "1" || !Array.isArray(value.scopes) || !value.scopes.every((scope) => validScope(root, scope))) return null;
    const ids = new Set(value.scopes.map((scope) => scope.id));
    const paths = new Set(value.scopes.map((scope) => scope.root));
    return ids.size === value.scopes.length && paths.size === value.scopes.length ? value : null;
  } catch {
    return null;
  }
};

const writeRegistry = (root: string, registry: SharedDocumentScopeRegistry): void => {
  const path = documentScopeRegistryPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
};

export const documentScopeRegistryPath = (root: string): string => join(root, REGISTRY_PATH);

export const registerSharedDocumentScope = (root: string, scope: SharedDocumentScope): string | undefined => {
  const existing = existsSync(documentScopeRegistryPath(root)) ? readRegistry(root) : { version: "1" as const, scopes: [] };
  if (!existing) return "协作文档库 scope registry 无效，拒绝覆盖";
  const sameId = existing.scopes.find((entry) => entry.id === scope.id);
  const sameRoot = existing.scopes.find((entry) => entry.root === scope.root);
  if (sameId && sameId.root !== scope.root) return `scope ID 已登记到其他路径: ${scope.id}`;
  if (sameRoot && sameRoot.id !== scope.id) return `scope 路径已登记为其他 ID: ${scope.root}`;
  if (!sameId) writeRegistry(root, { version: "1", scopes: [...existing.scopes, scope] });
  return undefined;
};

/** Returns undefined when the root has no valid shared-scope registry. */
export const registeredSharedDocumentScopes = (root: string): readonly SharedDocumentScope[] | undefined => readRegistry(root)?.scopes;
