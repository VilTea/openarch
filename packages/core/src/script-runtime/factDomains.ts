// 统一事实域注册表（校准 2026-08-08 第三轮）：脚本侧（ProjectFacts）与治理侧
// （FactSnapshot）共用同一套"域 → 类型化载荷"契约。新增事实 = 注册表加一项，
// 消费方（脚本 requires / selectFacts）自动获得——不再散落 7 处注册。
import type { FactDomainContract, FactResultLike } from "../domain/governance";
import type { ProjectFacts } from "../script-runtime/projectFacts";

/** 脚本侧域名（稳定，不带版本后缀；版本由载荷自述）。 */
export const SCRIPT_DOMAINS = [
  "file-classification",
  "structure-metrics",
  "authorities",
  "test-case-spans",
  "invocation-bindings",
  "semantic-relations",
  "change-surface",
] as const;

/** 治理侧域名。 */
export const GOVERNANCE_DOMAINS = [
  "architecture-policy",
  "structure-review",
  "anti-patterns",
  "test-governance",
  "analysis-scope",
] as const;

const extractFromProjectFacts = <Value>(field: (facts: ProjectFacts) => FactResultLike<Value>) =>
  (snapshot: unknown): FactResultLike<Value> =>
    field(snapshot as ProjectFacts);

/** 脚本事实域注册表：域 → ProjectFacts 强类型字段提取。 */
export const SCRIPT_FACT_DOMAINS: readonly FactDomainContract<unknown>[] = [
  { domain: "file-classification", valueType: undefined, extract: extractFromProjectFacts((f) => f.fileClassification), summaryKey: "scriptFact.fileClassification.summary", unavailableActionKey: "scriptFact.fileClassification.unavailable" },
  { domain: "structure-metrics", valueType: undefined, extract: extractFromProjectFacts((f) => f.structureMetrics), summaryKey: "scriptFact.structureMetrics.summary", unavailableActionKey: "scriptFact.structureMetrics.unavailable" },
  { domain: "authorities", valueType: undefined, extract: extractFromProjectFacts((f) => f.authorities), summaryKey: "scriptFact.authorities.summary", unavailableActionKey: "scriptFact.authorities.unavailable" },
  { domain: "test-case-spans", valueType: undefined, extract: extractFromProjectFacts((f) => f.testCaseSpans), summaryKey: "scriptFact.testCaseSpans.summary", unavailableActionKey: "scriptFact.testCaseSpans.unavailable" },
  { domain: "invocation-bindings", valueType: undefined, extract: extractFromProjectFacts((f) => f.invocationBindings), summaryKey: "scriptFact.invocationBindings.summary", unavailableActionKey: "scriptFact.invocationBindings.unavailable" },
  { domain: "semantic-relations", valueType: undefined, extract: extractFromProjectFacts((f) => f.semanticRelations), summaryKey: "scriptFact.semanticRelations.summary", unavailableActionKey: "scriptFact.semanticRelations.unavailable" },
  { domain: "change-surface", valueType: undefined, extract: extractFromProjectFacts((f) => f.changeSurface), summaryKey: "scriptFact.changeSurface.summary", unavailableActionKey: "scriptFact.changeSurface.unavailable" },
];

const scriptDomainById = new Map(SCRIPT_FACT_DOMAINS.map((entry) => [entry.domain, entry]));

/** 脚本域 → ProjectFacts 类型化载荷（替代 capabilityResult if-else 链）。 */
export const scriptDomainResult = (facts: ProjectFacts, domain: string): FactResultLike<unknown> | undefined =>
  scriptDomainById.get(domain)?.extract?.(facts);

/** 已知脚本域集合（开放校验用：未知域可声明，运行时 unavailable）。 */
export const knownScriptDomains = (): ReadonlySet<string> => new Set(SCRIPT_DOMAINS);

/** 治理侧域契约：域 → FactSnapshot 类型化载荷提取（与脚本域同构注册表）。 */
export const GOVERNANCE_FACT_DOMAINS: readonly FactDomainContract<unknown>[] = [
  { domain: "architecture-policy", valueType: undefined, summaryKey: "scriptFact.architecturePolicy.summary", unavailableActionKey: "scriptFact.architecturePolicy.unavailable" },
  { domain: "structure-review", valueType: undefined, summaryKey: "scriptFact.structureReview.summary", unavailableActionKey: "scriptFact.structureReview.unavailable" },
  { domain: "anti-patterns", valueType: undefined, summaryKey: "scriptFact.antiPatterns.summary", unavailableActionKey: "scriptFact.antiPatterns.unavailable" },
  { domain: "test-governance", valueType: undefined, summaryKey: "scriptFact.testGovernance.summary", unavailableActionKey: "scriptFact.testGovernance.unavailable" },
  { domain: "analysis-scope", valueType: undefined, summaryKey: "scriptFact.analysisScope.summary", unavailableActionKey: "scriptFact.analysisScope.unavailable" },
];
