// packages/core/src/domain/contractCatalog.ts
// 外部插件可消费的机器契约目录（唯一 authority）。
// 契约变更纪律：
// - 每个机器契约载荷必须在顶层带规范自识别字段 `schema`（值为下方 version），
//   插件一律读 `schema` 判断版本，不得用"缺 schema 即旧版"反推。
// - 任何破坏性变更必须先 bump 对应契约 version（v1 → v2），不允许静默改字段语义。
// - 新增非破坏字段可在同 version 内追加（消费者按缺省 fail-closed 处理）。
// - 退役契约在目录中保留一个 `status: "deprecated"` 的版本记录。
export type MachineContractStatus = "current" | "deprecated";

export interface MachineContractDescriptor {
  /** 稳定契约 id（不是版本；版本变化时不改名）。 */
  readonly id: string;
  /** 当前版本（破坏性变更时必须递增）。 */
  readonly version: string;
  readonly status: MachineContractStatus;
  /** 语言无关的一句话用途，供插件日志与契约差异报告使用。 */
  readonly summary: string;
}

/** `openarch contract --json` 自身输出的 schema 版本。 */
export const CONTRACT_CATALOG_SCHEMA = "contract-catalog-json-v1" as const;

/** 各机器契约当前版本常量：CLI 输出与目录共用同一来源，禁止分散字符串。 */
export const MACHINE_CONTRACT_VERSIONS = {
  contextJson: "context-json-v1",
  testGovernanceJson: "test-governance-json-v1",
  testGovernanceProviderListJson: "test-governance-provider-list-v1",
  rulesFactsJson: "rules-facts-json-v1",
  docsCheckJson: "docs-check-json-v1",
} as const;

export const machineContractDescriptors = (): readonly MachineContractDescriptor[] => [
  {
    id: "context-json",
    version: MACHINE_CONTRACT_VERSIONS.contextJson,
    status: "current",
    summary: "Read-only project governance facts: baseline identity, languages, policy populations, changes, readiness, scan status and exclusions.",
  },
  {
    id: "test-governance-json",
    version: MACHINE_CONTRACT_VERSIONS.testGovernanceJson,
    status: "current",
    summary: "Test governance collection, provider coverage boundaries, summaries, and adapter suggestions.",
  },
  {
    id: "test-governance-provider-list-json",
    version: MACHINE_CONTRACT_VERSIONS.testGovernanceProviderListJson,
    status: "current",
    summary: "Registered test governance provider/runner ids and labels.",
  },
  {
    id: "rules-facts-json",
    version: MACHINE_CONTRACT_VERSIONS.rulesFactsJson,
    status: "current",
    summary: "Self-describing script fact registry: domain, status, producer, usage, outputs, and installed-script consumers.",
  },
  {
    id: "docs-check-json",
    version: MACHINE_CONTRACT_VERSIONS.docsCheckJson,
    status: "current",
    summary: "Document-store check evidence: indexed documents, similarity candidates, unfilled record templates, and dispositions.",
  },
];
