/**
 * OpenArch DSH 插件 — 测试治理结果本地缓存。
 *
 * `openarch_test` 的评估结果目前只存在插件进程内；DSH 重启后会丢失。
 * 这里把最近一次有界投影写到 `<root>/.openarch/dsh-test-governance.json`，
 * 让看板在重启后仍能从本地缓存重建“测试治理”分区。
 *
 * 缓存是运行时投影，不是 OpenArch 的 gate/历史证据；只读展示用。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const cacheFileName = "dsh-test-governance.json";

const cachePath = (root) => join(root, ".openarch", cacheFileName);

/** 读取某工作区的测试治理缓存；缺失/损坏返回 null（fail-closed，不伪装 clean）。 */
export const readTestGovernanceCache = (root) => {
  try {
    const path = cachePath(root);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.schema === "test-governance-json-v1") return parsed;
    return null;
  } catch {
    return null;
  }
};

/** 写入某工作区的测试治理缓存；原子替换，失败静默（缓存不是关键路径）。 */
export const writeTestGovernanceCache = (root, value) => {
  try {
    const path = cachePath(root);
    mkdirSync(dirname(path), { recursive: true });
    const staging = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(staging, JSON.stringify(value, null, 2), "utf8");
    renameSync(staging, path);
  } catch {
    // 缓存写失败不阻断工具执行或看板展示。
  }
};
