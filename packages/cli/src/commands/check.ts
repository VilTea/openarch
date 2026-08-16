import { CommandHandler, isAnalyzableSourceFile } from "../runtime";
import { capabilityDriftSignal, evaluateProtectedPaths, loadProtectedPathPolicy } from "@openarch/core";
import { auditCommand } from "./audit";
import { diffCommand } from "./diff";
import { gateCommand } from "./gate";
import { testCommand } from "./test";
import { gitChangePaths } from "../gitChangePaths";
import { message } from "../i18n";

const combinedExit = (codes: readonly number[]): number =>
  codes.includes(3) ? 3 : codes.includes(2) ? 2 : codes.includes(1) ? 1 : 0;

/** Change-level protected-path policy from authority_hygiene; invalid policy fails closed. */
const protectedPathExit = (paths: readonly string[]): { readonly code: number; readonly lines: readonly string[] } => {
  const policy = loadProtectedPathPolicy();
  if (policy.errors.length > 0) {
    return { code: 3, lines: policy.errors.map((error) => `protected_paths 配置错误: ${error}`) };
  }
  if (!policy.configured || paths.length === 0) return { code: 0, lines: [] };
  const result = evaluateProtectedPaths(paths, policy);
  const lines = [
    "## protected_paths 裁决",
    `- Verdict: ${result.verdict}`,
    ...result.triggered.map(({ path, rule }) => `- [${rule.level.toUpperCase()}] ${path} 命中 ${rule.pattern}: ${rule.reason}`),
  ];
  return { code: result.verdict === "BLOCK" ? 2 : result.verdict === "WARN" ? 1 : 0, lines };
};

/** One change-verification workflow; the delegated commands remain internal implementation details. */
export const checkCommand: CommandHandler = async (args, context) => {
  if (args.includes("--record-config")) return auditCommand([], context);
  if (args.includes("--pre-commit") || args.includes("--reconcile-baseline")) return diffCommand(args, context);
  const staged = args.includes("--staged");
  const worktree = args.includes("--worktree");
  if (staged && worktree) {
    console.error(message(context.locale, "check.worktreeStagedConflict"));
    return 3;
  }
  const tests = args.includes("--tests");
  const full = args.includes("--full");
  const report = args.includes("--report");
  const verbose = args.includes("--verbose");
  const diffArgs = args.filter((arg) => arg !== "--report" && arg !== "--tests" && arg !== "--worktree" && arg !== "--full");
  const manualPaths = diffArgs.some((arg) => !arg.startsWith("--"));
  const manualChangedPaths = manualPaths ? diffArgs.filter((arg) => !arg.startsWith("--")) : [];
  const stagedPaths = staged ? gitChangePaths(context.cwd, "staged") : [];
  const worktreePaths = worktree ? gitChangePaths(context.cwd, "worktree") : [];
  const protectedChangedPaths = worktree ? worktreePaths : staged ? stagedPaths : manualChangedPaths;
  const protectedPolicy = protectedPathExit(protectedChangedPaths);
  for (const line of protectedPolicy.lines) console.log(line);
  if (protectedPolicy.code === 3) return 3;
  if (report && protectedChangedPaths.length > 0) {
    const drift = await capabilityDriftSignal(context.cwd, protectedChangedPaths);
    if (drift.error) {
      console.log(message(context.locale, "check.capabilityDriftHeading"));
      console.log(`- ${drift.error}`);
    } else if (drift.matched.length > 0) {
      console.log(message(context.locale, "check.capabilityDriftHeading"));
      for (const path of drift.matched) console.log(message(context.locale, "check.capabilityDriftEntry", { path }));
      console.log(message(context.locale, "check.capabilityDriftAction"));
    }
  }
  if (report && !staged && !manualPaths && !worktree) {
    console.log(message(context.locale, "check.scopeHeading"));
    console.log(message(context.locale, "check.scopeNoChange"));
    console.log(message(context.locale, "check.scopeCurrent"));
    console.log(message(context.locale, "check.scopeChange"));
  }
  // --full：跳过 diff 前置，直接全量分析（gate + audit + tests）——可用分析能力预留
  // 全量入口，不依赖 git 变更上下文（心流修复 2026-08-08：测试治理曾被 diff 前置
  // 卡死，只能靠伪造变更或删 baseline 触发）。
  if (full) {
    const results = [
      await gateCommand([...(report ? ["--report"] : [])], context),
      await auditCommand(["--check"], context),
      ...(tests ? [await testCommand(verbose ? ["--verbose"] : [], context)] : []),
      protectedPolicy.code,
    ];
    return combinedExit(results);
  }
  if (staged || manualPaths || worktree) {
    if (worktree && worktreePaths.length === 0) {
      console.log(message(context.locale, "check.worktreeEmpty"));
    }
    // 工作树有变更但其中没有可分析文件时，明确提示（体验反馈 2026-08-12：
    // 不能静默落到"用法错误"，也不能让"无变更"与"无可分析"混淆）。
    const worktreeAnalyzable = worktree
      ? worktreePaths.filter((path) => isAnalyzableSourceFile(path, context.cwd, "change-evidence"))
      : [];
    if (worktree && worktreePaths.length > 0 && worktreeAnalyzable.length === 0) {
      console.log(message(context.locale, "check.worktreeNoAnalyzable", { count: String(worktreePaths.length) }));
    }
    const impact = worktree && worktreeAnalyzable.length > 0
      ? await diffCommand([...diffArgs, ...worktreeAnalyzable], context)
      : staged || manualPaths
        ? await diffCommand(diffArgs, context)
        : 0;
    // diff 无可分析文件（如只有 baseline 变更）时不阻断后续测试治理——测试治理是全量
    // 静态分析，不依赖 diff 上下文（心流修复 2026-08-08：--worktree --tests 曾因
    // baseline 变更被 diff 前置卡死，测试治理跑不到）。
    if (impact !== 0 && impact !== undefined) return combinedExit([impact, protectedPolicy.code]);
  }
  const results = [
    await gateCommand([...(report ? ["--report"] : []), ...(staged ? ["--candidate"] : [])], context),
    await auditCommand(["--check"], context),
    ...(tests ? [await testCommand(verbose ? ["--verbose"] : [], context)] : []),
    protectedPolicy.code,
  ];
  return combinedExit(results);
};
