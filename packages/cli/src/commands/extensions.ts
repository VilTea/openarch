import { resolve } from "node:path";
import { checkExtensionContracts, MACHINE_CONTRACT_VERSIONS, readProjectLanguages, recommendedAntiPatternAssets, SCRIPT_AST_FACTS, SCRIPT_FACT_CAPABILITIES, SCRIPT_STARTERS, scriptFactConsumers, scriptStarter } from "@openarch/core";
import { CommandHandler, parseOptionValues } from "../runtime";
import { type Locale, type MessageKey, message } from "../i18n";

const extensionDirectories = (cwd: string): { "anti-patterns": string; "implicit-deps": string; "test-governance": string } => {
  const base = resolve(cwd, ".openarch");
  return {
    "anti-patterns": resolve(base, "anti-patterns", "rules"),
    "implicit-deps": resolve(base, "implicit-deps", "rules"),
    "test-governance": resolve(base, "test-governance", "rules"),
  };
};

interface FactView {
  readonly id: string;
  readonly kind: "requires" | "ast";
  readonly domain: string;
  readonly status: string;
  readonly producer: string;
  readonly summaryId: string;
  readonly usageId: string;
  readonly unavailableActionId?: string;
  readonly outputs: readonly string[];
  readonly builtinConsumers: readonly string[];
  readonly lifecycle?: string;
  readonly aliases: readonly string[];
  readonly consumers: { readonly requires: number; readonly astFact: number; readonly files: readonly string[] };
  readonly totalConsumers: number;
}

interface FactDescriptor {
  readonly id: string;
  readonly domain: string;
  readonly status: string;
  readonly producer: string;
  readonly summaryId: string;
  readonly usageId: string;
  readonly unavailableActionId?: string;
  readonly outputs: readonly string[];
  readonly builtinConsumers?: readonly string[];
  readonly lifecycle?: string;
  readonly aliases?: readonly string[];
}

const EMPTY_CONSUMERS = { requires: 0, astFact: 0, files: [] as readonly string[] };

const descriptorView = (
  fact: FactDescriptor,
  kind: "requires" | "ast",
  installed: { requires: number; astFact: number; files: readonly string[] },
): FactView => ({
  id: fact.id,
  kind,
  domain: fact.domain,
  status: fact.status,
  producer: fact.producer,
  summaryId: fact.summaryId,
  usageId: fact.usageId,
  ...(fact.unavailableActionId ? { unavailableActionId: fact.unavailableActionId } : {}),
  outputs: fact.outputs,
  builtinConsumers: fact.builtinConsumers ?? [],
  ...(fact.lifecycle ? { lifecycle: fact.lifecycle } : {}),
  aliases: fact.aliases ?? [],
  consumers: installed,
  totalConsumers: installed.requires + installed.astFact + (fact.builtinConsumers?.length ?? 0),
});

const factsView = (consumers: Readonly<Record<string, { requires: number; astFact: number; files: readonly string[] }>>): readonly FactView[] => [
  ...SCRIPT_FACT_CAPABILITIES.map((fact) => descriptorView(fact, "requires", consumers[fact.id] ?? EMPTY_CONSUMERS)),
  ...SCRIPT_AST_FACTS.map((fact) => descriptorView(fact, "ast", consumers[fact.id] ?? EMPTY_CONSUMERS)),
].sort((left, right) => `${left.domain}/${left.id}`.localeCompare(`${right.domain}/${right.id}`));

const factFilter = (facts: readonly FactView[], args: readonly string[], locale: Locale): readonly FactView[] => {
  const domains = new Set(parseOptionValues(args, "--domain").flatMap((value) => value.split(",")).filter(Boolean));
  const statuses = new Set(parseOptionValues(args, "--status").flatMap((value) => value.split(",")).filter(Boolean));
  const queries = parseOptionValues(args, "--query").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const unusedOnly = args.includes("--unused");

  return facts.filter((fact) => {
    if (domains.size > 0 && !domains.has(fact.domain)) return false;
    if (statuses.size > 0 && !statuses.has(fact.status)) return false;
    if (unusedOnly && fact.totalConsumers > 0) return false;
    if (queries.length === 0) return true;
    const summary = message(locale, fact.summaryId as MessageKey);
    const usage = message(locale, fact.usageId as MessageKey);
    const unavailable = fact.unavailableActionId ? message(locale, fact.unavailableActionId as MessageKey) : "";
    const haystack = `${fact.id} ${fact.aliases.join(" ")} ${fact.domain} ${fact.status} ${fact.producer} ${fact.outputs.join(" ")} ${summary} ${usage} ${unavailable}`.toLowerCase();
    return queries.some((query) => haystack.includes(query));
  });
};

const renderFactsJson = (facts: readonly FactView[], locale: Locale): string => JSON.stringify({
  schema: MACHINE_CONTRACT_VERSIONS.rulesFactsJson,
  facts: facts.map((fact) => ({
    id: fact.id,
    kind: fact.kind,
    domain: fact.domain,
    status: fact.status,
    producer: fact.producer,
    summaryId: fact.summaryId,
    usageId: fact.usageId,
    ...(fact.unavailableActionId ? { unavailableActionId: fact.unavailableActionId } : {}),
    summary: message(locale, fact.summaryId as MessageKey),
    usage: message(locale, fact.usageId as MessageKey),
    ...(fact.unavailableActionId ? { unavailableAction: message(locale, fact.unavailableActionId as MessageKey) } : {}),
    outputs: fact.outputs,
    builtinConsumers: fact.builtinConsumers,
    ...(fact.lifecycle ? { lifecycle: fact.lifecycle } : {}),
    aliases: fact.aliases,
    consumers: {
      requires: fact.consumers.requires,
      astFact: fact.consumers.astFact,
      files: fact.consumers.files,
    },
  })),
}, null, 2);

const factConsumerLine = (fact: FactView, locale: Locale): string => {
  const scriptConsumers = fact.consumers.requires + fact.consumers.astFact;
  if (scriptConsumers > 0) return message(locale, "rules.factConsumers", { files: fact.consumers.files.join(", ") });
  if (fact.totalConsumers > 0) return message(locale, "rules.factNoScriptConsumers");
  return message(locale, "rules.factConsumersNone");
};

const renderFactsText = (facts: readonly FactView[], locale: Locale): void => {
  console.log(message(locale, "rules.factsHeading"));
  let currentDomain: string | undefined;
  for (const fact of facts) {
    if (fact.domain !== currentDomain) {
      currentDomain = fact.domain;
      console.log(message(locale, "rules.factDomain", { domain: message(locale, `fact.domain.${fact.domain}` as MessageKey) }));
    }
    console.log(message(locale, "rules.factEntry", {
      id: fact.id,
      kind: fact.kind,
      status: message(locale, `fact.status.${fact.status}` as MessageKey),
      producer: message(locale, `fact.producer.${fact.producer}` as MessageKey),
      consumers: fact.totalConsumers,
      unused: fact.totalConsumers === 0 ? message(locale, "rules.factUnused") : "",
    }));
    console.log(message(locale, "rules.factSummary", { summary: message(locale, fact.summaryId as MessageKey) }));
    console.log(message(locale, "rules.factUsage", { usage: message(locale, fact.usageId as MessageKey) }));
    for (const output of fact.outputs) console.log(message(locale, "rules.factOutput", { output }));
    if (fact.unavailableActionId) console.log(message(locale, "rules.factUnavailable", { action: message(locale, fact.unavailableActionId as MessageKey) }));
    if (fact.builtinConsumers.length > 0) console.log(message(locale, "rules.factBuiltinConsumers", { consumers: fact.builtinConsumers.join(", ") }));
    if (fact.lifecycle) console.log(message(locale, "rules.factLifecycle", { lifecycle: fact.lifecycle }));
    if (fact.aliases.length > 0) console.log(message(locale, "rules.factAliases", { aliases: fact.aliases.join(", ") }));
    console.log(factConsumerLine(fact, locale));
  }
};

interface FactsArgumentState {
  readonly malformed: boolean;
  readonly unknownFlags: readonly string[];
  readonly positional: readonly string[];
}

const factsArgumentState = (args: readonly string[]): FactsArgumentState => {
  const optionFlags = new Set(["--domain", "--query", "--status"]);
  const knownFlags = new Set(["--facts", "--domain", "--query", "--status", "--unused", "--json"]);
  const valueArgs = new Set<string>();
  let malformed = false;
  for (let index = 0; index < args.length; index += 1) {
    if (!optionFlags.has(args[index])) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) malformed = true;
    else valueArgs.add(value);
  }
  return {
    malformed,
    unknownFlags: args.filter((arg) => arg.startsWith("--") && !knownFlags.has(arg)),
    positional: args.filter((arg, index) => !arg.startsWith("--") && !valueArgs.has(arg)),
  };
};

const renderTemplateRecommendations = (cwd: string, locale: Locale): void => {
  const recommendations = recommendedAntiPatternAssets(readProjectLanguages(cwd));
  console.log(message(locale, "rules.templatesHeading"));
  if (recommendations.length === 0) {
    console.log(message(locale, "rules.noTemplates"));
    return;
  }
  for (const asset of recommendations) {
    console.log(message(locale, "rules.template", { family: asset.patternFamily ?? "unclassified", id: asset.id }));
  }
};

const factsCommand = async (args: readonly string[], cwd: string, locale: Locale): Promise<number> => {
  const argumentState = factsArgumentState(args);
  if (argumentState.malformed || argumentState.unknownFlags.length > 0 || argumentState.positional.length > 0) {
    console.error(message(locale, "rules.factsUsage"));
    return 3;
  }
  const consumers = await scriptFactConsumers({ directories: extensionDirectories(cwd) });
  const facts = factFilter(factsView(consumers), args, locale);
  if (facts.length === 0) {
    console.log(message(locale, "rules.factNoMatches"));
    return 0;
  }
  if (args.includes("--json")) {
    console.log(renderFactsJson(facts, locale));
    return 0;
  }
  renderFactsText(facts, locale);
  console.log(message(locale, "rules.skeletons", { starters: SCRIPT_STARTERS.map((starter) => starter.id).join(", ") }));
  renderTemplateRecommendations(cwd, locale);
  return 0;
};

const extensionChecksCommand = async (args: readonly string[], cwd: string, locale: Locale): Promise<number> => {
  if (args.length === 2 && args[0] === "--skeleton") {
    const starter = scriptStarter(args[1]);
    if (!starter) {
      console.error(message(locale, "rules.unknownSkeleton", { skeleton: args[1], starters: SCRIPT_STARTERS.map((item) => item.id).join(", ") }));
      return 3;
    }
    console.log(starter.source);
    return 0;
  }
  if (args.length > 0 && !args.every((arg) => arg === "--check" || arg === "--unused")) {
    console.error(message(locale, "rules.usage"));
    return 3;
  }
  const report = await checkExtensionContracts({ directories: extensionDirectories(cwd) });
  console.log(message(locale, "rules.contractHeading"));
  console.log(message(locale, "rules.scripts", { count: report.checked }));
  console.log(message(locale, "rules.engines", { antiPatterns: report.byEngine["anti-patterns"], implicitDeps: report.byEngine["implicit-deps"], testGovernance: report.byEngine["test-governance"] }));
  for (const issue of report.issues) console.log(`  [INVALID:${issue.engine}] ${issue.path}: ${issue.error}`);
  if (args.includes("--unused")) {
    const consumers = await scriptFactConsumers({ directories: extensionDirectories(cwd) });
    const unused = factsView(consumers).filter((fact) => fact.totalConsumers === 0);
    const blockingUnused = unused.filter((fact) => !fact.lifecycle);
    console.log(message(locale, "rules.unusedHeading"));
    if (unused.length === 0) {
      console.log(message(locale, "rules.unusedNone"));
    } else {
      for (const fact of unused) {
        console.log(`  - ${fact.id} [${message(locale, `fact.domain.${fact.domain}` as MessageKey)} · ${message(locale, `fact.status.${fact.status}` as MessageKey)}]${fact.lifecycle ? ` — ${fact.lifecycle}` : ""}`);
      }
    }
    // CI 语义：合同无效是 3；无生命周期理由的零消费者事实是 WARN（1）；
    // 显式说明生命周期/退役条件的事实保持 report-only。
    return report.issues.length > 0 ? 3 : blockingUnused.length > 0 ? 1 : 0;
  }
  return report.issues.length === 0 ? 0 : 3;
};

export const extensionsCommand: CommandHandler = (args, context) => {
  const locale = context?.locale ?? "zh";
  const cwd = context?.cwd ?? process.cwd();
  return args[0] === "--facts" ? factsCommand(args, cwd, locale) : extensionChecksCommand(args, cwd, locale);
};
