// @ts-nocheck —— 插件包无独立 tsconfig，本文件以 vitest 转译运行。
//
// 跨包防漂移（认知点收敛）：DSH 插件不能 import core 的 TS 源码（跨包 + 独立 .mjs），
// 因此在包内 `host/openarch-contracts.mjs` 持有一份契约版本镜像。本用例守住两件事：
//   1. 镜像表本身不得漂移——这里硬编码期望值（沿用本包既有做法：测试用固定载荷断言）；
//   2. 包内消费者不得再写字面量——`openarch-state.mjs` / `openarch-test-cache.mjs`
//      必须消费 `openarch-contracts.mjs` 的键/谓词，否则"包内唯一入口"名存实亡。
//
// **与 core 的 `MACHINE_CONTRACT_VERSIONS` 对齐；core 变更时必须同步本用例。**
// core 侧的反向强制在 `packages/core/__tests__/contract-sync/pluginContractMirror.test.ts`
// （core 能按路径读到本镜像并逐值比对，插件侧读不到 core，故此处只能硬编码）。
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_CONTRACTS, isKnownTestGovernanceSchema } from "../host/openarch-contracts.mjs";
import { readTestGovernanceCache } from "../host/openarch-test-cache.mjs";

const hostDir = fileURLToPath(new URL("../host/", import.meta.url));

/**
 * 期望值 = core 唯一 authority 的当前取值：
 * - `catalog` → `packages/core/src/domain/contractCatalog.ts` 的 `CONTRACT_CATALOG_SCHEMA`；
 * - `contextJson` / `testGovernanceJson` / `testGovernanceProviderListJson`
 *   → 同文件 `MACHINE_CONTRACT_VERSIONS`；
 * - `metricContract` → `packages/core/src/domain/metricCatalog.ts` 的 `METRIC_CONTRACT_VERSION`。
 * 本表**故意**不是 core 目录的全量镜像：rules-facts-json / docs-check-json 本插件不读。
 */
const CORE_ALIGNED_CONTRACT_VERSIONS = {
  catalog: "contract-catalog-json-v1",
  contextJson: "context-json-v1",
  testGovernanceJson: "test-governance-json-v1",
  testGovernanceProviderListJson: "test-governance-provider-list-v1",
  metricContract: "metric-contract-v5",
};

/** 契约版本字面量（`"<family>-v<digits>"`）：包内消费者里出现即为第二份权威。 */
const CONTRACT_VERSION_LITERAL = /["'](?:contract-catalog-json|context-json|test-governance-json|test-governance-provider-list-json|metric-contract)-v\d+["']/;

describe("契约：插件契约镜像 ↔ core authority（跨包防漂移）", () => {
  it("KNOWN_CONTRACTS 与 core 的契约版本逐值一致（core 变更时必须同步本用例）", () => {
    // 键集也一并锁定：新增/删除识别项必须显式改本用例，不能静默扩大识别面。
    expect({ ...KNOWN_CONTRACTS }).toEqual(CORE_ALIGNED_CONTRACT_VERSIONS);
  });

  it("包内消费者（openarch-state / openarch-test-cache）不再写契约版本字面量", () => {
    // 只守本次收敛的两个消费者：openarch-tools-*.mjs 由各自 owner 处理，不在本用例范围内。
    for (const file of ["openarch-state.mjs", "openarch-test-cache.mjs"]) {
      const path = join(hostDir, file);
      expect(existsSync(path), `缺少消费者模块 ${file}`).toBe(true);
      const found = readFileSync(path, "utf8").match(CONTRACT_VERSION_LITERAL);
      expect(found?.[0] ?? null, `${file} 仍持有契约版本字面量，应消费 openarch-contracts.mjs`).toBe(null);
    }
  });

  it("test 治理缓存的契约识别跟随镜像表（未知 schema → null，不伪装命中）", () => {
    const root = mkdtempSync(join(tmpdir(), "openarch-contract-mirror-"));
    mkdirSync(join(root, ".openarch"), { recursive: true });
    const cachePath = join(root, ".openarch", "dsh-test-governance.json");
    writeFileSync(cachePath, JSON.stringify({ schema: KNOWN_CONTRACTS.testGovernanceJson, verdict: "PASS" }), "utf8");
    expect(readTestGovernanceCache(root)).toMatchObject({ verdict: "PASS" });
    expect(isKnownTestGovernanceSchema(`${KNOWN_CONTRACTS.testGovernanceJson}-next`)).toBe(false);
    writeFileSync(cachePath, JSON.stringify({ schema: `${KNOWN_CONTRACTS.testGovernanceJson}-next` }), "utf8");
    expect(readTestGovernanceCache(root)).toBe(null);
  });
});
