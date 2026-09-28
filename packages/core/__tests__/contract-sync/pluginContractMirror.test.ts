import { describe, expect, it } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONTRACT_CATALOG_SCHEMA, MACHINE_CONTRACT_VERSIONS } from "../../src/domain/contractCatalog";
import { METRIC_CONTRACT_VERSION } from "../../src/domain/metricCatalog";

/**
 * 跨包契约镜像的**唯一强制点**（contract-sync）。
 *
 * 背景：DSH 插件不能 import core 的 TS 源码（跨包 + 独立 `.mjs`），因此在
 * `packages/openarch-plugin/dsh/host/openarch-contracts.mjs` 持有本地镜像；镜像没有编译期保护，
 * 只能靠测试守漂移。插件侧的 `dsh/__tests__/openarch-contract-mirror.test.ts` 只能硬编码期望值，
 * 无法发现"core 已 bump、插件镜像没跟上"这一协同漂移——本用例补上这个方向：core 是 authority，
 * 由它按路径读取真实镜像文件并逐值比对（不是解析文本、不是复制常量）。
 *
 * 纪律：**这些版本值不得静默变更**。core 侧改 `MACHINE_CONTRACT_VERSIONS` /
 * `METRIC_CONTRACT_VERSION` / `CONTRACT_CATALOG_SCHEMA` 时，必须同步插件镜像与插件侧用例；
 * 只改一边，本用例或插件侧用例即失败。
 *
 * 插件镜像**故意**只登记它实际消费的契约（rules-facts-json / docs-check-json 不登记），
 * 所以这里比对的是"镜像声明的每一项都等于 core 的对应值"（键集也一并锁定：镜像新增识别项
 * 必须在此显式登记，不允许悄悄扩大识别面），而不是"镜像 == core 契约目录全量"。
 */
const mirrorPath = fileURLToPath(new URL("../../../openarch-plugin/dsh/host/openarch-contracts.mjs", import.meta.url));

describe("contract-sync: DSH 插件契约版本镜像 ↔ core authority", () => {
  it("插件镜像与 core authority 逐值一致（core bump 后插件未同步即失败）", async () => {
    const { KNOWN_CONTRACTS } = await import(pathToFileURL(mirrorPath).href);
    // 值 → core authority 的显式登记表（唯一 authority 在 core，插件侧只是本地镜像）。
    const coreAuthority = {
      catalog: CONTRACT_CATALOG_SCHEMA,
      contextJson: MACHINE_CONTRACT_VERSIONS.contextJson,
      testGovernanceJson: MACHINE_CONTRACT_VERSIONS.testGovernanceJson,
      testGovernanceProviderListJson: MACHINE_CONTRACT_VERSIONS.testGovernanceProviderListJson,
      metricContract: METRIC_CONTRACT_VERSION,
    };
    expect({ ...KNOWN_CONTRACTS }).toEqual(coreAuthority);
  });
});
