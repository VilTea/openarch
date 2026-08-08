import { Effect } from "effect";
import { gateApp } from "@openarch/core";
import { CommandHandler, LiveLayer } from "../runtime";
import { renderGateReport } from "../report/gateReport";

export const gateCommand: CommandHandler = async (args, context) => {
  const result = await Effect.runPromise(gateApp({ report: args.includes("--report"), projection: args.includes("--candidate") ? "pending" : "worktree" }).pipe(Effect.provide(LiveLayer)));
  for (const line of renderGateReport(result, context.locale)) {
    console.log(line);
  }
  return result.code;
};
