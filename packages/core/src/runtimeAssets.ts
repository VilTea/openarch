import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireCore = createRequire(import.meta.url);
const executableResourceRoots = (): readonly string[] =>
  [...new Set([process.argv[0], process.execPath].filter(Boolean).map((path) => join(dirname(path), "resources")))];

const isResourceRoot = (root: string): boolean =>
  existsSync(join(root, "assets", "templates", "default-scripts.json"))
  && existsSync(join(root, "grammars"));

/**
 * Resolves package-owned resources for source/npm execution and binary bundles.
 * A binary ships a sibling `resources/` directory; callers may explicitly
 * override it for a managed deployment.
 */
export const runtimeResourceRoot = (): string => {
  const configured = process.env.OPENARCH_RESOURCE_ROOT;
  const candidates = configured
    ? [resolve(configured)]
    : [...executableResourceRoots(), packageRoot];
  const root = candidates.find(isResourceRoot);
  if (root) return root;
  throw new Error(`OpenArch runtime resources unavailable. Expected assets/templates/default-scripts.json and grammars under: ${candidates.join(", ")}`);
};

export const runtimeResourcePath = (...segments: readonly string[]): string => join(runtimeResourceRoot(), ...segments);

/**
 * The bundled distribution owns this runtime WASM; source and npm execution
 * retain the dependency package as its authority.
 */
export const treeSitterRuntimePath = (): string => {
  const configured = process.env.OPENARCH_RESOURCE_ROOT;
  const bundleRoots = configured ? [resolve(configured)] : executableResourceRoots();
  const bundled = bundleRoots
    .map((root) => join(root, "tree-sitter", "web-tree-sitter.wasm"))
    .find(existsSync);
  return bundled ?? requireCore.resolve("web-tree-sitter/web-tree-sitter.wasm");
};
