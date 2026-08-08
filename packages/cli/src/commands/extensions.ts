import { checkExtensionContracts, readProjectLanguages, recommendedAntiPatternAssets, SCRIPT_AST_FACTS, SCRIPT_FACT_CAPABILITIES, SCRIPT_STARTERS, scriptStarter } from "@openarch/core";
import { CommandHandler } from "../runtime";
import { type MessageKey, message } from "../i18n";

export const extensionsCommand: CommandHandler = async (args, context) => {
  const locale = context?.locale ?? "zh";
  if (args.length === 1 && args[0] === "--facts") {
    console.log(message(locale, "rules.factsHeading"));
    for (const capability of SCRIPT_FACT_CAPABILITIES) {
      console.log(message(locale, "rules.fact", { id: capability.id, summary: message(locale, capability.summaryId as MessageKey), unavailable: message(locale, capability.unavailableActionId as MessageKey) }));
    }
    console.log(message(locale, "rules.astHeading"));
    for (const fact of SCRIPT_AST_FACTS) console.log(message(locale, "rules.astFact", { id: fact.id, summary: message(locale, fact.summaryId as MessageKey) }));
    console.log(message(locale, "rules.skeletons", { starters: SCRIPT_STARTERS.map((starter) => starter.id).join(", ") }));
    const languages = readProjectLanguages(context?.cwd ?? process.cwd());
    const recommendations = recommendedAntiPatternAssets(languages);
    console.log(message(locale, "rules.templatesHeading"));
    if (recommendations.length === 0) {
      console.log(message(locale, "rules.noTemplates"));
    } else {
      for (const asset of recommendations) {
        console.log(message(locale, "rules.template", { family: asset.patternFamily ?? "unclassified", id: asset.id }));
      }
    }
    return 0;
  }
  if (args.length === 2 && args[0] === "--skeleton") {
    const starter = scriptStarter(args[1]);
    if (!starter) {
      console.error(message(locale, "rules.unknownSkeleton", { skeleton: args[1], starters: SCRIPT_STARTERS.map((item) => item.id).join(", ") }));
      return 3;
    }
    console.log(starter.source);
    return 0;
  }
  if (args.length > 0 && !args.every((arg) => arg === "--check")) {
    console.error(message(locale, "rules.usage"));
    return 3;
  }

  const report = await checkExtensionContracts();
  console.log(message(locale, "rules.contractHeading"));
  console.log(message(locale, "rules.scripts", { count: report.checked }));
  console.log(message(locale, "rules.engines", { antiPatterns: report.byEngine["anti-patterns"], implicitDeps: report.byEngine["implicit-deps"], testGovernance: report.byEngine["test-governance"] }));
  for (const issue of report.issues) console.log(`  [INVALID:${issue.engine}] ${issue.path}: ${issue.error}`);
  return report.issues.length === 0 ? 0 : 3;
};
