/**
 * Governance runtime contract. These values retain evidence and policy boundaries
 * without importing Effect or any infrastructure implementation.
 */
export type GovernanceAvailability = "available" | "partial" | "unavailable";

/** 事实域（fact domain，校准 2026-08-08）：字符串分界，事实归属某个域。
 *  能力/信号按域消费事实，而非每次新增事实都去枚举可用事实。域是稳定有界的，
 *  事实可在域内独立演化。 */
export type FactDomain = string;

/** 域契约（校准 2026-08-08 第二轮）：不同域返回不同的事实抽象——每个域声明自己的
 *  载荷类型（Value），而非全部塞进统一 {value: unknown} 容器。脚本侧 ProjectFacts
 *  已是正例（structureMetrics → StructureMetricFact[]），治理侧对齐同构。
 *  domain 是稳定名（不带版本）；版本由载荷自述（value 结构含 schemaVersion）。
 *  第三轮：统一脚本/治理的域注册表——域 = 类型化载荷 + 提取器 + 生产契约。 */
export interface FactDomainContract<Value> {
  readonly domain: FactDomain;
  /** 该域事实的形状——类型化载荷，非 unknown。 */
  readonly valueType: Value;
  /** 从快照提取该域载荷（强类型字段访问；脚本侧 ProjectFacts 字段 → 域）。 */
  readonly extract?: (snapshot: unknown) => FactResultLike<Value>;
  /** 生产契约（可选 lazy）：按消费声明采集。 */
  readonly produce?: (ctx: FactDomainContext) => FactResultLike<Value>;
  readonly summaryKey: string;
  /** 不可用时的行动指引 key（CLI 建议）。 */
  readonly unavailableActionKey?: string;
}

/** 域生产上下文（lazy 采集的输入边界）。 */
export interface FactDomainContext {
  readonly cwd?: string;
  readonly requested?: readonly FactDomain[];
}

/** 域载荷通用形态：availability + 类型化 value + reason。 */
export interface FactResultLike<Value> {
  readonly availability: GovernanceAvailability;
  readonly value?: Value;
  readonly reason?: string;
}

export interface GovernanceFact<Value = unknown> {
  readonly id: string;
  /** 事实归属域——signal/finding/policy 按域聚合消费。 */
  readonly domain: FactDomain;
  readonly availability: GovernanceAvailability;
  readonly value?: Value;
  readonly reason?: string;
}

/** 治理侧事实快照（校准 2026-08-08 第二轮）：域 → 专用字段，与脚本侧 ProjectFacts 同构。
 *  每个域一个类型化槽位（scope 独立、facts 按域展开），消费方按域名取类型化载荷。 */
export interface FactSnapshot {
  /** Scope is itself evidence: configuration failures must not become a made-up fingerprint. */
  readonly scope: FactResultLike<{ readonly fingerprint: string }>;
  /** 各域类型化载荷（与脚本侧 ProjectFacts 字段同构）。 */
  readonly facts: Readonly<Record<string, FactResultLike<unknown>>>;
}

export interface Metric {
  readonly id: string;
  readonly value: number;
  readonly metricContractVersion: string;
  readonly calibrationProfileId?: string;
}

export interface Finding {
  readonly id: string;
  readonly assetId: string;
  /** 域级消费面：按事实域聚合（新事实归入已有域即被覆盖）。 */
  readonly domains: readonly FactDomain[];
  /** 事实级消费面：按具体事实按需消费（与 domains 不互斥）。 */
  readonly factIds: readonly string[];
  readonly confidence: "low" | "medium" | "high";
}

/** Diagnostic output. A signal is intentionally excluded from PolicySubject. */
export interface Signal {
  readonly id: string;
  readonly state: "observed" | "partial" | "unavailable";
  /** 域级消费面：按事实域聚合（新事实归入已有域即被覆盖）。 */
  readonly domains: readonly FactDomain[];
  /** 事实级消费面：按具体事实按需消费（与 domains 不互斥）。 */
  readonly factIds: readonly string[];
  readonly message: string;
}

/** 域 + 具体事实双消费面的选择条件（不互斥：域覆盖与具体 id 重叠时去重，只消费一次）。 */
export interface FactSelection {
  readonly domains?: readonly FactDomain[];
  readonly factIds?: readonly string[];
}

/**
 * 按事实域和/或具体事实 id 消费事实（校准 2026-08-08）。域级覆盖自动包含域内新增事实；
 * 具体 id 满足按需消费；两者重叠（某事实既在选中域内又被显式 id 点名）只返回一次——
 * 消费方不会重复处理同一事实。返回顺序保持输入 facts 顺序。
 */
export const selectFacts = (
  facts: readonly GovernanceFact[],
  selection: FactSelection,
): readonly GovernanceFact[] => {
  const domains = new Set(selection.domains ?? []);
  const ids = new Set(selection.factIds ?? []);
  return facts.filter((fact) => domains.has(fact.domain) || ids.has(fact.id));
}

export interface CalibrationProfile {
  readonly id: string;
  readonly analysisScopeFingerprint: string;
  readonly metricContractVersion: string;
  readonly populationFingerprint: string;
  readonly source: "baseline" | "provider" | "external-evidence";
}

export interface GovernanceAsset {
  readonly id: string;
  readonly kind: "provider" | "runner" | "project-script" | "template";
  readonly version: string;
}

export type PolicyAction = "report" | "warn" | "block";

export type PolicySubject =
  | { readonly kind: "metric"; readonly metricId: string }
  | { readonly kind: "finding"; readonly findingId: string };

export interface PolicyProjection {
  readonly policyId: string;
  readonly subject: PolicySubject;
  readonly action: PolicyAction;
}

const hasText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Rejects facts whose state would otherwise erase unavailable or partial evidence. */
export const validateGovernanceFact = <Value>(fact: GovernanceFact<Value>): GovernanceFact<Value> => {
  if (!hasText(fact.id)) throw new Error("GovernanceFact requires an id");
  if (fact.availability === "available" && fact.value === undefined) throw new Error("available GovernanceFact requires a value");
  if (fact.availability === "unavailable" && fact.value !== undefined) throw new Error("unavailable GovernanceFact cannot expose a value");
  if (fact.availability !== "available" && !hasText(fact.reason)) throw new Error("partial or unavailable GovernanceFact requires a reason");
  return fact;
};

/** Runtime guard for configuration/adapter boundaries; signals are not legal policy sources. */
export const validatePolicyProjection = (projection: PolicyProjection): PolicyProjection => {
  if (!hasText(projection.policyId)) throw new Error("PolicyProjection requires a policy id");
  if (!(["report", "warn", "block"] as const).includes(projection.action)) throw new Error("PolicyProjection has an invalid action");
  if (projection.subject.kind === "metric" && hasText(projection.subject.metricId)) return projection;
  if (projection.subject.kind === "finding" && hasText(projection.subject.findingId)) return projection;
  throw new Error("PolicyProjection source must be a metric or finding");
};

export const sameCalibrationPopulation = (left: CalibrationProfile, right: CalibrationProfile): boolean =>
  left.analysisScopeFingerprint === right.analysisScopeFingerprint
  && left.metricContractVersion === right.metricContractVersion
  && left.populationFingerprint === right.populationFingerprint
  && left.source === right.source;
