import { Effect, Either } from "effect";
import { classifyFileKindWithPolicy, configSnapshotSha256, configPath, createAnalysisScope, globSync, loadGateConfig, readProjectFileKindRules, readProjectLanguages, scan, sourceSnapshotSha256, type ScanResult } from "@openarch/core";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { exitCodeFromError } from "../exit-code";
import {
  CommandHandler,
  defaultScanPaths,
  LiveLayer,
  effectiveProjectRoot,
  isAnalyzableSourceFile,
  printAnalysisError,
  readImplicitDeps,
} from "../runtime";
import { governanceDiagnostics } from "./governanceDiagnostics";

export const scanCommand: CommandHandler = async (args, context) => {
  const projectCwd = effectiveProjectRoot(context.cwd);
  const sealCalibration = args.includes("--seal-calibration");
  const report = args.includes("--report");
  // 增量扫描（默认，校准 2026-08-08）：有 baseline 时只重算变更文件；--rebuild 强制全量重建。
  const rebuild = args.includes("--rebuild");
  const positionalArgs = args.filter((arg) => arg !== "--seal-calibration" && arg !== "--report" && arg !== "--rebuild");
  const rawPatterns = positionalArgs.flatMap((arg) => arg.split(",").map((segment) => segment.trim()).filter(Boolean));
  if (positionalArgs.length > 0 && rawPatterns.length === 0) {
    console.error("用法: openarch scan <glob|路径列表> (默认按项目语言扫描仓库源码)");
    return 3;
  }
  if (sealCalibration && rawPatterns.length > 0) {
    console.error("--seal-calibration 只能与完整项目 scan 一起使用，不能指定路径或 glob。");
    return 3;
  }

  const paths = rawPatterns.length > 0
    ? [...new Set(rawPatterns.flatMap((pattern) => {
      try {
        return globSync(pattern, {
          exclude: (path: string) => path.includes("node_modules") || path.includes("/dist/") || path.includes("\\dist\\"),
        });
      } catch {
        return [pattern];
      }
    }))].filter((path) => isAnalyzableSourceFile(path, context.cwd))
    : [...defaultScanPaths(context.cwd)];

  const implicitDeps = await readImplicitDeps();
  const fileKindRules = readProjectFileKindRules(projectCwd);
  const scope = createAnalysisScope(readProjectLanguages(projectCwd), fileKindRules);
  const gateConfig = await loadGateConfig();
  // P2-1（2026-08-11 体验反馈）：config.yml 内容变化时增量 scan 必须自动退化全量重建，
  // 否则 per-file sha256 身份对比对配置不敏感，策略改动后指标与策略匹配不更新。
  let configChanged = false;
  if (!rebuild && rawPatterns.length === 0) {
    const indexPath = resolve(projectCwd, ".openarch", "baseline", "_index.json");
    const cfgPath = resolve(projectCwd, ".openarch", "config.yml");
    const currentConfigHash = configSnapshotSha256(cfgPath);
    if (currentConfigHash !== undefined && existsSync(indexPath)) {
      try {
        const meta = JSON.parse(readFileSync(indexPath, "utf8")).meta as { configSnapshotSha256?: unknown } | undefined;
        configChanged = typeof meta?.configSnapshotSha256 === "string" && meta.configSnapshotSha256 !== currentConfigHash;
      } catch {
        configChanged = false;
      }
    }
    if (configChanged) console.error("⚠ 检测到 .openarch/config.yml 变更，自动退化全量重建（增量 scan 不感知配置变化）");
  }
  const result = await Effect.runPromise(scan(paths, implicitDeps, {
    analysisScope: scope,
    completeScope: rawPatterns.length === 0,
    incremental: !rebuild && !configChanged && rawPatterns.length === 0,
    ...(rawPatterns.length === 0 ? { sourceSnapshotSha256: sourceSnapshotSha256(paths, projectCwd) } : {}),
    ...(rawPatterns.length === 0 ? { configSnapshotSha256: configSnapshotSha256(resolve(projectCwd, ".openarch", "config.yml")) } : {}),
    calibrationWeights: gateConfig.crlStateWeights,
    structuralPolicies: gateConfig.structuralPolicies,
    sealCalibration,
    fileKindClassifier: (path) => classifyFileKindWithPolicy(path, fileKindRules, { projectRoot: projectCwd }),
    // Effect 3.21: scan() 的 gen R 推断含 service interface（ParserService），
    // 与 LiveLayer 的 Tag Out 在类型面不匹配；运行时 Layer 完整提供，断言只
    // 修正类型面（pre-existing，非本次引入）。
  }).pipe(Effect.provide(LiveLayer), Effect.either) as unknown as Effect.Effect<Either.Either<ScanResult, unknown>, never, never>);

  if (result._tag === "Right") {
    const transition = "calibrationTransition" in result.right ? result.right.calibrationTransition : undefined;
    const suffix = transition === "sealed"
      ? "；已封存当前门禁校准 epoch"
      : transition === "bootstrapped"
        ? "；已建立初始门禁校准 epoch"
        : "";
    console.log(`✓ scan 完成：${result.right.nFiles} 文件${suffix}`);
    if (report) {
      console.log("## 当前结构复盘（scan 后快照）");
      console.log("- 这是当前结构的 report-only 概览；改动前后的 D_MR 请在 scan 前运行 openarch check --staged --report。");
      const diagnostics = await governanceDiagnostics(context.locale);
      if ("unavailable" in diagnostics) console.log(`- [UNAVAILABLE] 治理复盘: ${diagnostics.unavailable}`);
      else for (const line of diagnostics.lines) console.log(line);
    }
    return 0;
  }

  printAnalysisError(result.left, context.locale);
  return exitCodeFromError(result.left);
};
