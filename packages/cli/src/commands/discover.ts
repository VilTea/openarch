import { Effect } from "effect";
import { discover, implicitDepsPath } from "@openarch/core";
import { exitCodeFromError } from "../exit-code";
import { CommandHandler, LiveLayer, parseOptionValue } from "../runtime";

export const discoverCommand: CommandHandler = async (args) => {
  const firstRule = parseOptionValue(args, "--rule");
  const rules = firstRule
    ? args.slice(args.indexOf("--rule") + 1).filter((arg) => !arg.startsWith("--"))
    : undefined;
  // 变更模式（change-surface.v1 接通，2026-08-07）：脚本聚焦变更文件，
  // facts.changeSurface 提供 changedSymbols（变更的声明）
  const source = args.includes("--staged") ? "staged" : args.includes("--worktree") ? "worktree" : undefined;
  const result = await Effect.runPromise(discover({ rules, ...(source ? { source } : {}) }).pipe(Effect.provide(LiveLayer), Effect.either));

  if (result._tag === "Right") {
    const report = result.right;
    console.log("## 隐式依赖发现");
    console.log(`- 规则执行: ${report.rulesRun}`);
    console.log(`- 本轮识别边: ${report.edgesFound}`);
    console.log(`- 落地变化: +${report.edgesAdded} / -${report.edgesRemoved}`);
    console.log(`- 落地总边: ${report.totalEdges} → ${implicitDepsPath()}`);
    for (const stage of report.pruning) {
      console.log(`  - ${stage.source}: input=${stage.inputFiles} targets=${stage.targetFiles} candidates=${stage.candidateFiles} records=${stage.records}`);
    }
    for (const error of report.errors) {
      console.log(`  ⚠ ${error}`);
    }
    return 0;
  }

  return exitCodeFromError(result.left);
};
