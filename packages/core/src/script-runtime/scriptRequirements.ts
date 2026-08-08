import { loadDefaultExport, type ScriptImport } from "./loadDefaultExport";
import { isScriptFactRequirements, type ScriptFactCapability } from "./projectFacts";
import { mapWithConcurrency } from "../infra/boundedConcurrency";

/**
 * Reads only public script metadata before facts are assembled. This lets a
 * costly provider stay lazy while every script engine follows the same rule.
 * Execution still loads and validates the script itself, so invalid modules
 * retain their normal error behavior.
 */
export const requestedScriptCapabilities = async (
  paths: readonly string[],
  importFn?: ScriptImport,
): Promise<readonly ScriptFactCapability[]> => {
  const modules = await mapWithConcurrency(paths, (path) => loadDefaultExport(path, importFn));
  const requested = new Set<ScriptFactCapability>();
  for (const module of modules) {
    const value = module.value;
    const requires = value && typeof value === "object" ? (value as Record<string, unknown>).requires : undefined;
    if (isScriptFactRequirements(requires)) for (const capability of requires ?? []) requested.add(capability);
  }
  return [...requested].sort();
};
