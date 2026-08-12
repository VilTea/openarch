import { Effect } from "effect";
import { testGovernance, testGovernanceProviderList } from "@openarch/core";
import { exitCodeFromError } from "../exit-code";
import { renderTestGovernanceReport } from "../report/testReport";
import { CommandHandler, LiveLayer, printAnalysisError } from "../runtime";

export const testCommand: CommandHandler = async (args, context) => {
  if (args.includes("--list")) {
    console.log("已注册的测试治理 provider（config.yml test_governance.providers 使用 id）：");
    for (const provider of testGovernanceProviderList()) {
      console.log(`  ${provider.id}  —  ${provider.label}`);
    }
    return 0;
  }

  const result = await Effect.runPromise(testGovernance({ includeBloat: true }).pipe(Effect.provide(LiveLayer), Effect.either));
  if (result._tag === "Left") {
    printAnalysisError(result.left);
    return exitCodeFromError(result.left);
  }

  for (const line of renderTestGovernanceReport(result.right, args)) console.log(line);
  return result.right.decision.verdict === "BLOCK" ? 2 : result.right.decision.verdict === "WARN" ? 1 : 0;
};
