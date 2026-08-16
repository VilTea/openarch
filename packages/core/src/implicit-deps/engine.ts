// packages/core/src/implicit-deps/engine.ts
// Implicit-dependency rules share the engine-owned staged traversal used by other project scripts.
import { ParserService } from "../port/ParserService";
import { executeStagedScript } from "../staged-analysis/engine";
import { isStagedRuleContract, type StageExecution } from "../staged-analysis/types";
import { loadDefaultExport, type ScriptImport } from "../script-runtime/loadDefaultExport";
import { normalizeRepositoryPath, type ProjectFacts } from "../script-runtime/projectFacts";
import type { DiscoveredEdge, DiscoveredObservation, ImplicitDependencyLinkResult, ImplicitDependencyRule } from "./types";

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

const isDiscoveredObservation = (value: unknown): value is DiscoveredObservation => {
  if (!value || typeof value !== "object") return false;
  const observation = value as Record<string, unknown>;
  return (observation.kind === "unresolved_key" || observation.kind === "dynamic_key" || observation.kind === "note")
    && typeof observation.via === "string"
    && Array.isArray(observation.files) && observation.files.every((file) => typeof file === "string")
    && (observation.message === undefined || typeof observation.message === "string");
};

const linkResultOf = (output: readonly unknown[] | unknown): { readonly edges: readonly DiscoveredEdge[]; readonly observations: readonly DiscoveredObservation[]; readonly error?: string } => {
  if (Array.isArray(output)) {
    return output.every(isDiscoveredEdge)
      ? { edges: output, observations: [] }
      : { edges: [], observations: [], error: "边必须包含 from/to/via/type 字符串字段" };
  }
  if (!output || typeof output !== "object") {
    return { edges: [], observations: [], error: "link 必须返回 DiscoveredEdge[] 或 { edges, observations }" };
  }
  const result = output as { edges?: unknown; observations?: unknown };
  if (!Array.isArray(result.edges) || !result.edges.every(isDiscoveredEdge)) {
    return { edges: [], observations: [], error: "link.edges 必须是 DiscoveredEdge[]" };
  }
  if (result.observations !== undefined && (!Array.isArray(result.observations) || !result.observations.every(isDiscoveredObservation))) {
    return { edges: [], observations: [], error: "link.observations 必须是 DiscoveredObservation[]" };
  }
  return { edges: result.edges, observations: (result.observations ?? []) as readonly DiscoveredObservation[] };
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
): Promise<{ edges: DiscoveredEdge[]; observations: DiscoveredObservation[]; error?: string; unavailable?: string; stages?: Pick<StageExecution, "inputFiles" | "targetFiles" | "candidateFiles" | "records"> }> => {
  const loaded = await loadDefaultExport(mjsPath, importFn);
  if (loaded.error) return { edges: [], observations: [], error: loaded.error };
  if (!isImplicitDependencyRule(loaded.value)) return { edges: [], observations: [], error: `${mjsPath}: 必须 export default { stages, link }` };
  try {
    const execution = await executeStagedScript(loaded.value, files, parserSvc, { facts: options.facts, allFiles: options.allFiles, log });
    if (execution.error) return { edges: [], observations: [], error: `${mjsPath}: ${execution.error}` };
    if (execution.unavailable) return { edges: [], observations: [], unavailable: execution.unavailable };
    const linked = linkResultOf(execution.output);
    if (linked.error) return { edges: [], observations: [], error: `${mjsPath}: ${linked.error}` };
    const normalized = canonicalizeEdges(linked.edges);
    if (!normalized.edges) return { edges: [], observations: [], error: `${mjsPath}: ${normalized.error}` };
    const edges = normalized.edges;
    log(`${edges.length} edges`);
    return { edges: [...edges], observations: [...linked.observations], stages: execution.stages };
  } catch (error) {
    return { edges: [], observations: [], error: `${mjsPath}: ${error instanceof Error ? error.message : String(error)}` };
  }
};
