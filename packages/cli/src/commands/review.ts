import { Effect } from "effect";
import { collectGitCommitHistory, evolutionReview } from "@openarch/core";
import { renderEvolutionReport, renderEvolutionUnavailable } from "../report/evolutionReport";
import { CommandHandler, LiveLayer, printAnalysisError } from "../runtime";
import { governanceDiagnostics } from "./governanceDiagnostics";

export const reviewCommand: CommandHandler = async (args, context) => {
  if (args.includes("--evolution")) {
    const gitHistory = collectGitCommitHistory(context.cwd);
    if (gitHistory.availability === "unavailable") {
      for (const line of renderEvolutionUnavailable(gitHistory.reason, context.locale)) console.log(line);
      return 0;
    }
    const result = await Effect.runPromise(evolutionReview(context.cwd, gitHistory.changeSets).pipe(Effect.provide(LiveLayer), Effect.either));
    if (result._tag === "Left") {
      printAnalysisError(result.left);
      return 1;
    }
    for (const line of renderEvolutionReport(result.right, context.locale)) console.log(line);
    return 0;
  }
  const diagnostics = await governanceDiagnostics(context.locale);
  if ("unavailable" in diagnostics) {
    console.error(`治理复盘 UNAVAILABLE: ${diagnostics.unavailable}`);
    return 1;
  }
  for (const line of diagnostics.lines) console.log(line);
  return 0;
};
