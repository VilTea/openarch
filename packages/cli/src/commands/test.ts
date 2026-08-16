import { Effect } from "effect";
import { MACHINE_CONTRACT_VERSIONS, testGovernance, testGovernanceProviderList } from "@openarch/core";
import { exitCodeFromError } from "../exit-code";
import { renderTestGovernanceReport, testGovernanceJsonValue } from "../report/testReport";
import { CommandHandler, LiveLayer, printAnalysisError } from "../runtime";

export const testCommand: CommandHandler = async (args, context) => {
  const json = args.includes("--json");
  if (args.includes("--list")) {
    const providers = testGovernanceProviderList().map((provider) => ({ id: provider.id, label: provider.label }));
    if (json) {
      console.log(JSON.stringify({ schema: MACHINE_CONTRACT_VERSIONS.testGovernanceProviderListJson, providers }, null, 2));
      return 0;
    }
    console.log("已注册的测试治理 provider（config.yml test_governance.providers 使用 id）：");
    for (const provider of providers) {
      console.log(`  ${provider.id}  —  ${provider.label}`);
    }
    return 0;
  }

  const includeBloat = args.includes("--bloat") || args.includes("--verbose");
  const result = await Effect.runPromise(testGovernance({ includeBloat }).pipe(Effect.provide(LiveLayer), Effect.either));
  if (result._tag === "Left") {
    printAnalysisError(result.left);
    return exitCodeFromError(result.left);
  }

  if (json) console.log(JSON.stringify(testGovernanceJsonValue(result.right), null, 2));
  else for (const line of renderTestGovernanceReport(result.right, args)) console.log(line);
  return result.right.decision.verdict === "BLOCK" ? 2 : result.right.decision.verdict === "WARN" ? 1 : 0;
};
