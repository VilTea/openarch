// packages/core/src/implicit-deps/engine.ts
// Implicit-dependency rules share the engine-owned staged traversal used by other project scripts.
import { ParserService } from "../port/ParserService";
import { executeStagedScript } from "../staged-analysis/engine";
import { isStagedRuleContract, type StageExecution } from "../staged-analysis/types";
import { loadDefaultExport, type ScriptImport } from "../script-runtime/loadDefaultExport";
import { normalizeRepositoryPath, type ProjectFacts } from "../script-runtime/projectFacts";
import type { DiscoveredEdge, ImplicitDependencyRule } from "./types";

const log = (...args: unknown[]) => console.error("[openarch:rule]", ...args);

export const isImplicitDependencyRule = (value: unknown): value is ImplicitDependencyRule => {
  return isStagedRuleContract(value);
};

const isDiscoveredEdge = (value: unknown): value is DiscoveredEdge => {
  if (!value || typeof value !== "object") return false;
  const edge = value as Record<string, unknown>;
  return typeof edge.from === "string" && typeof edge.to === "string"
    && typeof edge.via === "string" && typeof edge.type === "string";
};

const canonicalizeEdges = (edges: readonly DiscoveredEdge[]): { readonly edges?: DiscoveredEdge[]; readonly error?: string } => {
  const seen = new Set<string>();
  const result: DiscoveredEdge[] = [];
  for (const edge of edges) {
    const from = normalizeRepositoryPath(edge.from);
    const to = normalizeRepositoryPath(edge.to);
    if (!from || !to || from === "." || to === "." || from === ".." || to === ".." || from.startsWith("../") || to.startsWith("../")) {
      return { error: "隐式依赖端点必须是项目内的非空文件路径" };
    }
    const normalized = { ...edge, from, to };
    const key = `${from}\0${to}\0${normalized.via}\0${normalized.type}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return { edges: result };
};

/** Loads one public rule contract and delegates traversal to the shared staged runtime. */
export const executeRule = async (
  mjsPath: string,
  files: readonly string[],
  parserSvc: ParserService,
  importFn: ScriptImport = (url) => import(url),
  options: { readonly facts?: ProjectFacts; readonly allFiles?: readonly string[] } = {},
): Promise<{ edges: DiscoveredEdge[]; error?: string; unavailable?: string; stages?: Pick<StageExecution, "inputFiles" | "targetFiles" | "candidateFiles" | "records"> }> => {
  const loaded = await loadDefaultExport(mjsPath, importFn);
  if (loaded.error) return { edges: [], error: loaded.error };
  if (!isImplicitDependencyRule(loaded.value)) return { edges: [], error: `${mjsPath}: 必须 export default { stages, link }` };
  try {
    const execution = await executeStagedScript(loaded.value, files, parserSvc, { facts: options.facts, allFiles: options.allFiles, log });
    if (execution.error) return { edges: [], error: `${mjsPath}: ${execution.error}` };
    if (execution.unavailable) return { edges: [], unavailable: execution.unavailable };
    if (!execution.output.every(isDiscoveredEdge)) return { edges: [], error: `${mjsPath}: 边必须包含 from/to/via/type 字符串字段` };
    const normalized = canonicalizeEdges(execution.output);
    if (!normalized.edges) return { edges: [], error: `${mjsPath}: ${normalized.error}` };
    const edges = normalized.edges;
    log(`${edges.length} edges`);
    return { edges: [...edges], stages: execution.stages };
  } catch (error) {
    return { edges: [], error: `${mjsPath}: ${error instanceof Error ? error.message : String(error)}` };
  }
};
