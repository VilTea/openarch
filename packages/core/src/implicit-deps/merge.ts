// packages/core/src/implicit-deps/merge.ts
// .openarch/implicit-deps.yml 的读写 + 按 source 合并。
// 合并语义：替换同 source 的旧边，保留其他来源 + 手改边（source: "manual"）。
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { load, dump } from "js-yaml";
import { implicitDepsPath } from "../infra/paths";
import { normalizeRepositoryPath } from "../script-runtime/projectFacts";
import { atomicWriteTextIfChanged } from "../adapter/storage/AtomicWriter";
import type { DiscoveredEdge, StoredEdge } from "./types";

const HEADER = `# 隐式依赖（由 openarch rules discover 生成；可手改——删误报、加备注、source 改 manual 保护不被覆盖）
# 重新 discover 时按 source 合并：同来源的旧边替换，其他来源/手改边保留。
`;

const repositoryPath = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`implicit-deps ${field} must be a non-empty path`);
  const normalized = normalizeRepositoryPath(value);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new Error(`implicit-deps ${field} must stay inside the project: ${value}`);
  }
  return normalized;
};

const parseStoredEdge = (value: unknown, index: number): StoredEdge => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`implicit-deps entry ${index} must be an object`);
  const edge = value as Record<string, unknown>;
  const from = repositoryPath(edge.from, `entry ${index}.from`);
  const to = repositoryPath(edge.to, `entry ${index}.to`);
  if (typeof edge.via !== "string" || edge.via.length === 0 || typeof edge.type !== "string" || edge.type.length === 0
    || typeof edge.source !== "string" || edge.source.length === 0
    || (edge.confidence !== "confirmed" && edge.confidence !== "low")
    || (edge.note !== undefined && typeof edge.note !== "string")) {
    throw new Error(`implicit-deps entry ${index} has invalid relation metadata`);
  }
  return { from, to, via: edge.via, type: edge.type, source: edge.source, confidence: edge.confidence, ...(edge.note === undefined ? {} : { note: edge.note }) };
};

const edgeKey = (edge: Pick<StoredEdge, "from" | "to" | "via" | "type" | "source">): string =>
  `${edge.from}\0${edge.to}\0${edge.via}\0${edge.type}\0${edge.source}`;

/** 读 implicit-deps.yml。缺文件返回 []；存在但损坏时显式失败，不能伪装为空图。 */
export const readImplicitDepsYml = (path: string = implicitDepsPath()): StoredEdge[] => {
  if (!existsSync(path)) return [];
  let data: unknown;
  try { data = load(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`${path}: malformed YAML: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(data)) throw new Error(`${path}: root must be an array of stored edges`);
  const edges = data.map(parseStoredEdge);
  if (new Set(edges.map(edgeKey)).size !== edges.length) throw new Error(`${path}: duplicate stored edge`);
  return edges;
};

/** 按 source 合并：用 discovered 替换该 source 的旧边，保留其他来源的边。
 *  source = "manual" 的边永不被自动替换（人手加的保护边）。 */
export const mergeBySource = (
  existing: readonly StoredEdge[],
  discovered: readonly DiscoveredEdge[],
  source: string,
): StoredEdge[] => {
  const kept = existing.filter(e => e.source !== source);   // 丢弃同 source 旧边，保留其他
  const added: StoredEdge[] = discovered.map(d => ({
    ...d,
    source,
    confidence: "low" as const,                              // MVP 全 low，Phase B 加确认闸门
  }));
  return [...kept, ...added];
};

/** 写 implicit-deps.yml（HEADER + YAML dump，原子写）。 */
export const writeImplicitDepsYml = (
  edges: readonly StoredEdge[],
  path: string = implicitDepsPath(),
): Promise<void> => {
  const normalized = edges.map(parseStoredEdge);
  if (new Set(normalized.map(edgeKey)).size !== normalized.length) throw new Error("implicit-deps contains duplicate stored edge");
  mkdirSync(dirname(path), { recursive: true });
  return atomicWriteTextIfChanged(path, HEADER + dump(normalized.map(e => ({ ...e })), { lineWidth: 120 }) + "\n").then(() => undefined);
};
