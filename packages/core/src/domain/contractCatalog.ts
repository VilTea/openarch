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

/**
 * 各机器契约当前版本常量：CLI 输出与目录共用同一来源，禁止分散字符串。
 *
 * **这些版本值不得静默变更。** 外部插件（DSH 插件不能 import 本 TS 源码）在
 * `packages/openarch-plugin/dsh/host/openarch-contracts.mjs` 持有本地镜像；
 * core↔镜像的对齐由 `__tests__/contract-sync/pluginContractMirror.test.ts` 强制，
 * 镜像自身的防漂移由插件包 `dsh/__tests__/openarch-contract-mirror.test.ts` 守住。
 * 改这里必须同步那两处，并考虑 bump 后旧值是否需要 `status: "deprecated"` 记录。
 */
export const MACHINE_CONTRACT_VERSIONS = {
  contextJson: "context-json-v1",
  // test-governance-json 保持 v1：新增的逐条 finding 投影（decision.findings）是非破坏性
  // 追加字段，遵循本文件契约纪律第 3 条（消费者 fail-closed，缺省即旧行为）；
  // 插件的识别面只校验 schema id，`decision` 为 additionalProperties:true，故无需协同 bump。
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
    // 伴读载荷必须在这里被点名，否则就是"事实存在但没有入口"：`test --bloat` 的 `bloat` 子载荷
    // （`score` / `triggered` / `availableWeight` / `parts[]{name,value,threshold,weight,contribution,
    // availability,reason}` / `similarityBuckets` / 文件证据 / `weakAssertionShapesSource`）
    // **没有自己的 schema 字段**，它是本契约内的伴读子载荷 ⇒ **刻意不为它另立 id**
    // （目录里出现一个线上读不到的 id 属幻影契约）。
    // 纪律：report-only；不可测时省略取值并给 `availability` + `reason`，绝不写 0；不持久化、不参与裁决。
    // `weakAssertionShapesSource`（`project`|`builtin`，2026-09-27 §6/Q1）是**可选追加**披露字段：
    // 说明弱断言判据生效的是项目声明的名单还是内置默认；消费方按缺省 fail-closed，schema 版本不 bump。
    summary: "Test governance collection, provider coverage boundaries, per-finding locations (decision.findings), summaries, adapter suggestions, and the report-only TEST_BLOAT companion payload (parts[](value/threshold/weight/availability/reason), weakAssertionShapesSource, shapes identity in baseline meta — no separate schema field on purpose).",
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
