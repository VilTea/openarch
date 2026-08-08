// baseline entries 计算（拆自 scan.ts——校准 2026-08-08）：每文件 metrics 组装与
// P95 输入收集。独立文件控制 scan.ts 的局部负担在项目 P95 阈值内。
import { resolve } from "node:path";
import type { FileAst, Language } from "../domain/ast";
import type { IndexEntry } from "../port/StorageService";
import type { FileKind } from "../domain/testGovernance";
import { reach } from "../domain/reach";
import { confidence } from "../domain/confidence";
import { alphaStruct } from "../domain/alpha";
import { weightedBranchTotalOf } from "../domain/branchMetrics";
import { participatesInPopulation } from "../domain/fileParticipation";
import { projectRoot, toRelative } from "../infra/paths";
import { contentHashesOf } from "../projectFiles";
import { projectBaselineEntry } from "./baselineEntry";

const norm = (p: string) => resolve(p).replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`);

/** 单文件 baseline entry 计算。 */
const computeEntryForAst = (
  ast: FileAst,
  fileKind: FileKind,
  inDegrees: ReadonlyMap<string, number>,
  reverseGraph: ReadonlyMap<string, readonly string[]>,
  nProductionFiles: number,
  previousByPath: ReadonlyMap<string, IndexEntry>,
  useMaxDepth: number,
  contentHashes: ReadonlyMap<string, string>,
): IndexEntry => {
  const isProduction = participatesInPopulation(fileKind, "production-governance");
  const r = isProduction ? reach(reverseGraph, norm(ast.path), useMaxDepth) : 0;
  const weightedControlFlow = weightedBranchTotalOf(ast);
  const c = confidence({ passthroughCalls: ast.passthroughCalls, weightedControlFlow, structuralNodeEstimate: Math.max(ast.passthroughCalls + weightedControlFlow + ast.functionCount, 1) });
  const a = isProduction ? alphaStruct({ reach: r, confidence: c, nFiles: Math.max(nProductionFiles, 1) }) : 0;
  const relativePath = toRelative(resolve(ast.path));
  const previous = previousByPath.get(relativePath) ?? previousByPath.get(ast.path);
  const entry = projectBaselineEntry({
    ast,
    fileKind,
    inDegree: inDegrees.get(norm(ast.path)) ?? 0,
    alphaStruct: a,
    previous,
  });
  // 内容身份：增量扫描的变更检测基准（复用文件已带 hash，重算文件从文件读）
  return { ...entry, contentSha256: contentHashes.get(norm(ast.path)) };
};

/** 组装 baseline entries 与 P95 输入。增量时复用文件直接沿用 baseline 分片
 *  （内容等价），重算文件由 AST 计算。 */
export const computeEntries = (
  asts: readonly FileAst[],
  fileKinds: ReadonlyMap<string, FileKind>,
  inDegrees: ReadonlyMap<string, number>,
  reverseGraph: ReadonlyMap<string, readonly string[]>,
  nProductionFiles: number,
  previousByPath: ReadonlyMap<string, IndexEntry>,
  useMaxDepth: number,
  incremental: boolean,
  reusedEntries: readonly IndexEntry[],
  paths: readonly string[],
): { readonly entries: readonly IndexEntry[]; readonly p95Inputs: { readonly branch: number[]; readonly nesting: number[]; readonly loc: number[]; readonly alpha: number[]; readonly oneMinusConn: number[]; readonly externalPassthrough: number[] } } => {
  const p95Inputs = { branch: [] as number[], nesting: [] as number[], loc: [] as number[], alpha: [] as number[], oneMinusConn: [] as number[], externalPassthrough: [] as number[] };
  const entries: IndexEntry[] = [];
  // 内容身份（sha256）：增量扫描变更检测基准。全量读全部文件；增量读重算文件、
  // 复用文件直接沿用 baseline 快照（文件未变，哈希未变）。
  const contentHashes = new Map<string, string>();
  if (incremental) {
    for (const entry of reusedEntries) if (entry.contentSha256) contentHashes.set(norm(entry.path), entry.contentSha256);
    for (const [key, hash] of contentHashesOf(asts.map((ast) => ast.path), projectRoot())) contentHashes.set(norm(resolve(projectRoot(), key)), hash);
  } else {
    for (const [key, hash] of contentHashesOf(paths, projectRoot())) contentHashes.set(norm(resolve(projectRoot(), key)), hash);
  }
  // 增量：未变更文件复用 baseline per-file metrics（内容等价——文件未变）；
  // 结构字段与 p95 归一化输入一并带入，保证快照完整且 p95 与全量一致。
  for (const entry of reusedEntries) {
    entries.push(entry);
    if (participatesInPopulation(entry.fileKind, "production-governance")) {
      p95Inputs.branch.push(entry.maxFuncBranch ?? 0);
      p95Inputs.nesting.push(entry.nestingDepth);
      p95Inputs.loc.push(entry.loc ?? 0);
      p95Inputs.alpha.push(entry.alphaStruct);
      p95Inputs.oneMinusConn.push(1 - (entry.connectedness ?? 0));
      p95Inputs.externalPassthrough.push(entry.externalPassthroughCalls ?? 0);
    }
  }
  for (const ast of asts) {
    const fileKind = fileKinds.get(ast.path) ?? "production";
    const entry = computeEntryForAst(ast, fileKind, inDegrees, reverseGraph, nProductionFiles, previousByPath, useMaxDepth, contentHashes);
    entries.push(entry);
    if (participatesInPopulation(fileKind, "production-governance")) {
      const weightedControlFlow = weightedBranchTotalOf(ast);
      p95Inputs.branch.push(entry.maxFuncBranch ?? weightedControlFlow);
      p95Inputs.nesting.push(ast.nestingDepth);
      p95Inputs.loc.push(ast.loc ?? 0);
      p95Inputs.alpha.push(entry.alphaStruct);
      p95Inputs.oneMinusConn.push(1 - (entry.connectedness ?? 0));
      p95Inputs.externalPassthrough.push(entry.externalPassthroughCalls ?? 0);
    }
  }
  return { entries, p95Inputs };
};

/** 项目可用语言（增量扫描时复用文件的 language 从 baseline entry 取）。 */
export const projectLanguages = (incremental: boolean, reusedEntries: readonly IndexEntry[], asts: readonly FileAst[]): readonly string[] =>
  incremental
    ? [...new Set([...reusedEntries.map((entry) => entry.language).filter((language): language is Language => language !== undefined), ...asts.map((ast) => ast.language)])]
    : [...new Set(asts.map((ast) => ast.language))];
