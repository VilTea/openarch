import { CommandHandler } from "../runtime";
import { auditCommand } from "./audit";
import { diffCommand } from "./diff";
import { gateCommand } from "./gate";
import { testCommand } from "./test";
import { gitChangePaths } from "../gitChangePaths";
import { message } from "../i18n";

const combinedExit = (codes: readonly number[]): number =>
  codes.includes(3) ? 3 : codes.includes(2) ? 2 : codes.includes(1) ? 1 : 0;

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
    ];
    return combinedExit(results);
  }
  if (staged || manualPaths || worktree) {
    const worktreePaths = worktree ? gitChangePaths(context.cwd, "worktree") : [];
    if (worktree && worktreePaths.length === 0) {
      console.log(message(context.locale, "check.worktreeEmpty"));
    }
    const impact = worktree && worktreePaths.length > 0
      ? await diffCommand([...diffArgs, ...worktreePaths], context)
      : staged || manualPaths
        ? await diffCommand(diffArgs, context)
        : 0;
    // diff 无可分析文件（如只有 baseline 变更）时不阻断后续测试治理——测试治理是全量
    // 静态分析，不依赖 diff 上下文（心流修复 2026-08-08：--worktree --tests 曾因
    // baseline 变更被 diff 前置卡死，测试治理跑不到）。
    if (impact !== 0 && impact !== undefined) return impact;
  }
  const results = [
    await gateCommand([...(report ? ["--report"] : []), ...(staged ? ["--candidate"] : [])], context),
    await auditCommand(["--check"], context),
    ...(tests ? [await testCommand(verbose ? ["--verbose"] : [], context)] : []),
  ];
  return combinedExit(results);
};
