/**
 * OpenArch DSH 插件 — 上游机器契约目录常量与投影（Host 纯逻辑）。
 *
 * 上游 authority 是 `openarch contract --json`（见 packages/core/src/domain/contractCatalog.ts）。
 * 本模块持有插件认识的契约版本（本地镜像，插件不能 import core）：任何不认识的 schema 一律
 * fail-closed，绝不按旧版结构静默解析（上游契约纪律）。
 *
 * 本表是**包内唯一的契约版本识别入口**：其它 host 模块（openarch-state.mjs、
 * openarch-test-cache.mjs、openarch-tools-*.mjs）一律消费这里的键，不得再写字面量。
 *
 * `metricContract` 属于本表而不是别处：它是**上游持久化工件**
 * `.openarch/baseline/_index.json` 的 `meta.metricContractVersion` 契约版本，与其它项同属
 * "插件认识哪些上游版本"这一个概念——不认识就 fail-closed（标 unsupported，不按旧版结构猜字段）。
 * core 侧对应 domain/metricCatalog.ts 的 `METRIC_CONTRACT_VERSION`。
 *
 * 本表只登记**插件实际消费**的契约，不是 core `MACHINE_CONTRACT_VERSIONS` 的镜像超集：
 * rules-facts-json / docs-check-json 本插件不读，故意不登记（无消费者的识别项只会增加认知点）。
 * 与 core 的对齐由 packages/core/__tests__/contract-sync/pluginContractMirror.test.ts 反向强制，
 * 本表自身的防漂移由 __tests__/openarch-contract-mirror.test.ts 守住。
 */
export const KNOWN_CONTRACTS = Object.freeze({
  catalog: "contract-catalog-json-v1",
  contextJson: "context-json-v1",
  testGovernanceJson: "test-governance-json-v1",
  testGovernanceProviderListJson: "test-governance-provider-list-v1",
  metricContract: "metric-contract-v5",
});

/** 契约目录的有界投影（状态槽/dashboard 只留 id+version+status，summary 不进常驻快照）。 */
export function projectContractCatalog(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.schema !== "string" || value.schema !== KNOWN_CONTRACTS.catalog) return null;
  const contracts = Array.isArray(value.contracts)
    ? value.contracts
        .slice(0, 20)
        .filter((c) => c && typeof c.id === "string" && typeof c.version === "string")
        .map((c) => ({
          id: c.id,
          version: c.version,
          status: c.status === "deprecated" ? "deprecated" : "current",
        }))
    : [];
  return {
    schema: value.schema,
    openarchVersion: typeof value.openarchVersion === "string" ? value.openarchVersion : null,
    contracts,
  };
}

/** test --json 的契约版本是否被本插件认识（不认识 → 调用方 fail-closed）。 */
export const isKnownTestGovernanceSchema = (schema) => schema === KNOWN_CONTRACTS.testGovernanceJson;

/** test --list --json 的契约版本是否被本插件认识。 */
export const isKnownProviderListSchema = (schema) => schema === KNOWN_CONTRACTS.testGovernanceProviderListJson;
