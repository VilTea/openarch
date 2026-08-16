/**
 * OpenArch DSH 插件 — 上游机器契约目录常量与投影（Host 纯逻辑）。
 *
 * 上游 authority 是 `openarch contract --json`（contract-catalog-json-v1，
 * 见 packages/core/src/domain/contractCatalog.ts）。本模块持有插件认识的
 * 契约版本（本地镜像，插件不能 import core）：任何不认识的 schema 一律
 * fail-closed，绝不按旧版结构静默解析（上游契约纪律）。
 */
export const KNOWN_CONTRACTS = Object.freeze({
  catalog: "contract-catalog-json-v1",
  contextJson: "context-json-v1",
  testGovernanceJson: "test-governance-json-v1",
  testGovernanceProviderListJson: "test-governance-provider-list-v1",
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
