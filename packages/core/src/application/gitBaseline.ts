// 冷启动 git 基线重建（2026-08-11 体验反馈 P2-2 的正面实现）：
// 无 baseline 时，从 git HEAD 记录重建"改动前"状态，使 check/diff 在首次
// clone 后（未 scan）也能计算本次未提交改动的冲击量（I_push / D_MR）。
// 这是"初次扫描从 git 恢复原始状态做变更对比"官方口径的实现——用 HEAD blob
// 重建 before 度量，而不是要求用户先 scan。
import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import { Effect } from "effect";
import type { ParserService } from "../port/ParserService";
import type { SemanticBeforeMetrics } from "./semanticDiff";
import { readGitBlobs } from "./gitBlobBatch";

/** git HEAD commit sha（非 git 仓库时返回 undefined）。 */
export const gitHeadSha = (cwd: string): string | undefined => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 10000 }).trim() || undefined;
  } catch {
    return undefined;
  }
};

/** 从 git HEAD blob 重建单文件 before 度量（无 baseline 冷启动用）。
 *  文件在 HEAD 中不存在（新增文件）时返回 null——新增文件无"改动前"状态。 */
export const buildGitBeforeMetrics = async (
  parser: ParserService,
  cwd: string,
  filePath: string,
): Promise<SemanticBeforeMetrics | null> => {
  const headSha = gitHeadSha(cwd);
  if (!headSha) return null;
  const relPath = relative(cwd, filePath).replace(/\\/g, "/");
  const blobs = readGitBlobs(cwd, [{ key: relPath, object: `${headSha}:${relPath}` }]);
  const source = blobs.get(relPath);
  if (!source?.text) return null;
  const ast = await Effect.runPromise(parser.parseText(filePath, source.text!)).catch(() => null);
  if (!ast) return null;
  return {
    weightedBranchTotal: ast.weightedBranchTotal ?? ast.branchCount,
    maxFuncBranch: ast.maxFuncBranch,
    nestingDepth: ast.nestingDepth,
    loc: ast.loc ?? 0,
    externalPassthroughCalls: ast.externalPassthroughCalls ?? ast.passthroughCalls,
  };
};
