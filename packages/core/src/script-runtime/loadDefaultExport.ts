import { pathToFileURL } from "node:url";

export type ScriptImport = (url: string) => Promise<Record<string, unknown>>;

/** Extension modules have one public entry point. No legacy named-export fallback is retained. */
export const loadDefaultExport = async (
  mjsPath: string,
  importFn: ScriptImport = (url) => import(url),
): Promise<{ readonly value?: unknown; readonly error?: string }> => {
  try {
    const mod = await importFn(pathToFileURL(mjsPath).href);
    if (!("default" in mod)) return { error: `${mjsPath}: 必须 export default` };
    return { value: mod.default };
  } catch (error) {
    return { error: `${mjsPath}: ${error instanceof Error ? error.message : String(error)}` };
  }
};
