import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { LAMBDA_AST, collectSymbolUseReports, collectTypeScriptSymbolVersionPair, diff, prefilterStaticBoundEmpty, readHistoryRetentionPolicy, staticConsumerFilesFor, reconcileBaseline, sealPendingEvidence, symbolUseDemandForProfiles, symbolUseRequestPolicy, type ChangeKind, type SymbolUseDemand, type SymbolUseReport, type SymbolVersionPairReport } from "@openarch/core";
import { exitCodeFromError } from "../exit-code";
import { renderDiffReport } from "../report/diffReport";
import { message, type Locale } from "../i18n";
import {
  CommandHandler,
  LiveLayer,
  isAnalyzableSourceFile,
  parseOptionValue,
  printAnalysisError,
  readImplicitDeps,
} from "../runtime";
import { missingEvidenceForStagedFiles, stagedEvidenceForPaths } from "../semanticEvidence";
import { automaticSemanticProfiles, parseChangeOverrides, type ChangeOverrides } from "../semanticProfiles";
import { gitChangePaths } from "../gitChangePaths";

interface DiffRequest {
  readonly paths: readonly string[];
  readonly changeType?: ChangeKind;
  readonly changeOverrides: ChangeOverrides;
}

const stagedPaths = (cwd: string): string[] =>
  gitChangePaths(cwd, "staged").filter((path) => isAnalyzableSourceFile(path, cwd, "change-evidence"));

const verifyStagedEvidence = (paths: readonly string[], cwd: string): number => {
  const missing = missingEvidenceForStagedFiles(paths, cwd);
  if (missing.length > 0) {
    console.error(
      `缺少已暂存语义证据: ${missing.join(", ")}。` +
      "先运行 openarch check --staged --report；自动分析若不可用，会一次列出所有待确认文件及 --change-override 骨架。",
    );
    return 1;
  }
  console.log("staged diff 的语义变更类型未知；已验证显式证据，未重复写入 I_push/history。");
  return 0;
};

const baseRevision = (): string => {
  try { return execSync("git rev-parse HEAD", { encoding: "utf8", timeout: 5000 }).trim() || "uncommitted-base"; }
  catch { return "uncommitted-base"; }
};

/** 项目是否有 durable 符号校准样本（.openarch/calibration/symbol/ 有 profile）。
 *  校准 2026-08-08：admission calibration_samples 据此判 available，不再写死 partial。 */
const hasDurableCalibrationSamples = (cwd: string): boolean => {
  try {
    const dir = join(cwd, ".openarch", "calibration", "symbol");
    return existsSync(dir) && readdirSync(dir).some((name) => name.endsWith(".json"));
  } catch { return false; }
};

const finalizeStagedEvidence = async (paths: readonly string[], cwd: string, locale: Locale): Promise<number> => {
  let rawWindowDays: number;
  try {
    rawWindowDays = (await readHistoryRetentionPolicy(cwd)).rawWindowDays;
  } catch (error) {
    console.error(message(locale, "history.invalidPolicy", { detail: error instanceof Error ? error.message : String(error) }));
    return 3;
  }
  const result = await Effect.runPromise(sealPendingEvidence({
    stagedEvidence: stagedEvidenceForPaths(paths, cwd),
    rawWindowDays,
    agentId: process.env.OPENARCH_AGENT_ID ?? "git-hook",
  }).pipe(Effect.provide(LiveLayer), Effect.either));
  if (result._tag === "Left") { printAnalysisError(result.left); return exitCodeFromError(result.left); }
  if (result.right.status === "finalized") {
    console.log("已封存与暂存区匹配的 semantic evidence。");
    if (result.right.compaction?.compactedEntries) {
      console.log(message(locale, "history.compacted", { compacted: result.right.compaction.compactedEntries, retained: result.right.compaction.retainedEntries }));
    }
    return 0;
  }
  if (result.right.status === "mismatch") {
    console.error("暂存源码与 pending semantic evidence 不一致；请针对当前暂存内容重新运行 openarch check --staged。");
    return 1;
  }
  return verifyStagedEvidence(paths, cwd);
};

const reconcileBaselineCommand = async (): Promise<number> => {
    const result = await Effect.runPromise(reconcileBaseline().pipe(Effect.provide(LiveLayer), Effect.either));
    if (result._tag === "Left") { printAnalysisError(result.left); return exitCodeFromError(result.left); }
    if (result.right.stale.length > 0) {
      console.error(`发现 ${result.right.stale.length} 个不再有源码的 baseline 条目；未原地删除。请运行 openarch scan 发布完整新基线。`);
      return 1;
    }
    console.log("baseline generation 没有发现孤立条目。");
    return 0;
};

const earlyDiffCommand = (args: readonly string[], cwd: string, locale: Locale): Promise<number | undefined> => {
  if (args.includes("--reconcile-baseline")) return reconcileBaselineCommand();
  if (args.includes("--pre-commit")) {
    const paths = stagedPaths(cwd);
    return paths.length === 0 ? Promise.resolve(0) : finalizeStagedEvidence(paths, cwd, locale);
  }
  return Promise.resolve(undefined);
};

const stagedDiffRequest = (args: readonly string[], cwd: string): DiffRequest | undefined => {
  if (args.includes("--pre-commit")) {
    console.error("--staged 与 --pre-commit 不能同时使用");
    return undefined;
  }
  const changeType = parseOptionValue(args, "--change-type");
  if (changeType !== undefined && !(changeType in LAMBDA_AST)) {
    console.error(`非法 --change-type: ${changeType}。合法值: ${Object.keys(LAMBDA_AST).join(", ")}`);
    return undefined;
  }
  const paths = stagedPaths(cwd);
  if (paths.length === 0) {
    console.log("暂存区没有匹配当前项目 languages 配置的可分析文件。");
    return { paths: [], changeOverrides: new Map() };
  }
  const changeOverrides = parseChangeOverrides(args);
  if (!changeOverrides) return undefined;
  if (changeType && changeOverrides.size > 0) {
    console.error("--change-type 与 --change-override 不能同时使用");
    return undefined;
  }
  return { paths, changeOverrides, ...(changeType ? { changeType: changeType as ChangeKind } : {}) };
};

const parseDiffRequest = (args: readonly string[], cwd: string): DiffRequest | undefined => {
  const changeType = parseOptionValue(args, "--change-type");
  if (changeType !== undefined && !(changeType in LAMBDA_AST)) {
    console.error(`非法 --change-type: ${changeType}。合法值: ${Object.keys(LAMBDA_AST).join(", ")}`);
    return undefined;
  }
  const changeOverrides = parseChangeOverrides(args);
  if (!changeOverrides) return undefined;
  if (changeType && changeOverrides.size > 0) {
    console.error("--change-type 与 --change-override 不能同时使用");
    return undefined;
  }
  const fileArgs = [...args];
  for (let index = fileArgs.length - 1; index >= 0; index--) {
    if (fileArgs[index] === "--change-type" || fileArgs[index] === "--change-override") fileArgs.splice(index, 2);
  }
  const providedPaths = fileArgs.filter((arg) => !arg.startsWith("--")).flatMap((arg) => arg.split(",")).map((path) => path.trim()).filter(Boolean);
  if (providedPaths.length === 0) { console.error("用法: openarch check [--change-type <type>|--change-override <path>=<type>] <files>"); return undefined; }
  const paths = providedPaths.filter((path) => isAnalyzableSourceFile(path, cwd, "change-evidence"));
  if (paths.length === 0) { console.error("没有匹配当前项目 languages 配置的可分析文件。"); return undefined; }
  return { paths, changeOverrides, ...(changeType ? { changeType: changeType as ChangeKind } : {}) };
};

const executeDiff = async (
  request: DiffRequest,
  locale: Locale,
  semanticProfiles?: readonly import("@openarch/core").SemanticFileProfile[],
  afterTexts?: ReadonlyMap<string, string>,
  symbolUseReports?: readonly SymbolUseReport[],
  detail = false,
  versionPairs?: readonly SymbolVersionPairReport[],
  calibrationAvailable = false,
): Promise<number> => {
  const implicitDeps = await readImplicitDeps();
  const changedFiles = semanticProfiles ? semanticProfiles.map((profile) => profile.file) : request.paths;
  const result = await Effect.runPromise(diff({
    changedFiles,
    baselinePath: ".openarch/baseline.json",
    ...(request.changeType ? { changeKind: request.changeType } : { semanticProfiles }),
    ...(afterTexts ? { afterTexts } : {}),
    ...(symbolUseReports ? { symbolUseReports } : {}),
    ...(versionPairs ? { versionPairs } : {}),
    ...(calibrationAvailable ? { calibrationAvailable } : {}),
    persistence: "pending",
    revisionKey: baseRevision(),
    agentId: process.env.OPENARCH_AGENT_ID ?? "default",
    implicitDeps,
  }).pipe(Effect.provide(LiveLayer), Effect.either));
  if (result._tag === "Right") {
    renderDiffReport(result.right, locale, { detail }).forEach((line) => console.log(line));
    return 0;
  }
  printAnalysisError(result.left);
  return exitCodeFromError(result.left);
};

/** LSP reads the worktree, so its facts must never be presented as Git-index evidence. */
const worktreeSymbolUse = async (cwd: string, demand: SymbolUseDemand, waitForDiagnostics = false): Promise<readonly SymbolUseReport[]> => {
  const result = await Effect.runPromise(collectSymbolUseReports(cwd, demand, waitForDiagnostics).pipe(Effect.provide(LiveLayer), Effect.either));
  if (result._tag === "Right") return result.right;
  return [];
};

export const diffCommand: CommandHandler = async (args, context) => {
  if (args.includes("--staged") && args.includes("--pre-commit")) {
    console.error("--staged 与 --pre-commit 不能同时使用");
    return 3;
  }
  if (args.includes("--staged") && args.includes("--semantic")) {
    console.error("--semantic 只能分析工作树；暂存快照继续使用静态语法证据。");
    return 3;
  }
  const early = await earlyDiffCommand(args, context.cwd, context.locale);
  if (early !== undefined) return early;
  const request = args.includes("--staged") ? stagedDiffRequest(args, context.cwd) : parseDiffRequest(args, context.cwd);
  if (!request) return 3;
  if (request.paths.length === 0) return 0;
  const locale = context.locale;
  const detail = args.includes("--verbose");
  if (request.changeType) return executeDiff(request, locale, undefined, undefined, undefined, detail);
  const semantic = await automaticSemanticProfiles(
    context.cwd,
    request.paths,
    request.changeOverrides,
    args.includes("--staged") ? "staged" : "worktree",
    locale,
  );
  if (!semantic) return 3;
  // 预筛（规格 §3.4）：静态上界为空（baseline inDegree=0）的变更文件跳过 LSP——
  // 符号消费者必为空（引用符号必须 import 其所在文件），无需启动昂贵的符号分析。
  const waitIndex = args.includes("--wait-index");
  const demandProfiles = await Effect.runPromise(prefilterStaticBoundEmpty(semantic.profiles).pipe(Effect.provide(LiveLayer), Effect.either));
  const filteredProfiles = demandProfiles._tag === "Right" && demandProfiles.right.length < semantic.profiles.length
    ? demandProfiles.right
    : semantic.profiles;
  // 静态消费者候选引导 LSP 索引（Go/Rust 校准 2026-08-05）：仅变更文件时
  // gopls demand 确认 0/15 生产调用者；注入静态上界消费者让 references 覆盖跨包调用。
  const consumerFiles = await Effect.runPromise(staticConsumerFilesFor(filteredProfiles).pipe(Effect.provide(LiveLayer), Effect.either));
  const consumerFilesOk = consumerFiles._tag === "Right" ? consumerFiles.right : [];
  // 能力声明驱动（校准 2026-08-08）：请求条件由 provider 能力声明决定
  // （compiler-based provider 无需 LSP 门控），而非调用方硬编码语言列表。
  const needsSymbolUse = symbolUseRequestPolicy(filteredProfiles, { semantic: args.includes("--semantic") });
  const symbolUseReports = needsSymbolUse
    ? await worktreeSymbolUse(context.cwd, symbolUseDemandForProfiles(filteredProfiles, consumerFilesOk), args.includes("--semantic") ? waitIndex : false)
    : undefined;
  // version-pair 证据（admission before/after 身份，校准 2026-08-08）：仅当符号级可用且
  // 变更含 TypeScript/JavaScript 时采集——TS compiler provider 支持 Git revision 快照，
  // Go/Rust/Java/Python 的 LSP provider 无此能力（collectSymbolVersionPair 返回 unavailable）。
  let versionPairs: readonly SymbolVersionPairReport[] | undefined;
  if (needsSymbolUse && semantic.profiles.some((profile) => /\.(ts|tsx|js|jsx)$/.test(profile.file))) {
    try {
      const pair = collectTypeScriptSymbolVersionPair(context.cwd);
      if (pair.availability === "available") versionPairs = [pair];
    } catch { /* version-pair 采集失败不阻断主流程（admission 保持 unavailable） */ }
  }
  // durable 校准样本检测：项目校准存储有 profile → admission calibration_samples available
  const calibrationAvailable = hasDurableCalibrationSamples(context.cwd);
  return executeDiff(request, locale, semantic.profiles, semantic.afterTexts, symbolUseReports, detail, versionPairs, calibrationAvailable);
};
