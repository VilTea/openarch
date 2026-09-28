import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditConfig } from "../../src/application/configAudit";
import { loadAuthorityHygieneConfig } from "../../src/application/authorityHygiene";
import { loadProtectedPathPolicy } from "../../src/application/protectedPaths";
import { readGovernancePersistence, readHistoryRetentionPolicy } from "../../src/application/governancePersistence";
import { capabilityDriftSignal } from "../../src/document-store/CapabilityDrift";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

/**
 * 配置读取面的**平价用例**（config.yml 唯一读取权威收敛，2026-09-25 项目所有者批准）。
 *
 * 同一份"存在但读不出来"的 config.yml（重复映射键 ⇒ js-yaml 抛 `duplicated mapping key`）下，
 * 五个消费者的失败语义**各自不变**——收敛只允许"去掉重复读取 + 让原因更具体"，不允许把
 * 抛错改成吞掉、或把吞掉改成抛错：
 *   1. `authorityHygiene`：吞掉并上报（`qualityErrors` 非空、authorities 空）；
 *   2. `protectedPaths`：吞掉但上报，且 `configured` 仍为 `true`（"有声明但读不出来"）；
 *   3. `capabilityDriftSignal`：report-only（`error` 非空、不匹配任何路径、不影响 verdict）；
 *   4. `governancePersistence`：**抛错**（严格 fail-closed，`init` 会以 exit 3 报告）；
 *   5. `auditConfig`：**不解析 YAML**，只按字节算 sha256 ⇒ 坏 YAML 也必须正常返回哈希。
 */
describe("config.yml 读取面的失败语义（唯一权威收敛的平价用例）", () => {
  const malformed = "presentation:\n  locale: zh\n  locale: en\n";

  it("同一份坏配置下，五个消费者各自保持原有失败语义", () => withTemporaryDirectory("config-parity", async (dir) => {
    // 重复映射键：这是真实发生过的那一份（D-G12 的 `duplicated mapping key`）。
    mkdirSync(join(dir, ".openarch"), { recursive: true });
    writeFileSync(join(dir, ".openarch", "config.yml"), malformed, { flag: "w" });
    const previous = process.env.OPENARCH_BASE_DIR;
    process.env.OPENARCH_BASE_DIR = join(dir, ".openarch");
    try {
      // 1) opt-in 身份：吞掉但上报，且原因带出解析错误原文
      const hygiene = loadAuthorityHygieneConfig();
      expect(hygiene.authorities).toEqual([]);
      expect(hygiene.qualityErrors.join(" ")).toContain("duplicated mapping key");

      // 2) 保护路径：`configured` 仍是 true（不得被改成"未配置"）
      const policy = loadProtectedPathPolicy();
      expect(policy.configured).toBe(true);
      expect(policy.rules).toEqual([]);
      expect(policy.errors.join(" ")).toContain("duplicated mapping key");

      // 3) 能力漂移：report-only，读不出来不改变任何裁决
      const drift = capabilityDriftSignal(dir, ["packages/core/src/adapter/parser/TsStrategy.ts"]);
      expect(drift.watch).toEqual([]);
      expect(drift.matched).toEqual([]);
      expect(drift.error).toContain("duplicated mapping key");

      // 4) 治理持久化：严格抛错（不得被收敛成默认值）
      await expect(readGovernancePersistence(dir)).rejects.toThrow("duplicated mapping key");
      await expect(readHistoryRetentionPolicy(dir)).rejects.toThrow("duplicated mapping key");

      // 5) 配置审计：字节哈希读者，不是 YAML 读者 ⇒ 坏 YAML 也照常给出哈希
      const audit = auditConfig("record", join(dir, ".openarch"));
      expect(audit.status).not.toBe("missing_config");
      expect(audit.currentHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      if (previous === undefined) delete process.env.OPENARCH_BASE_DIR;
      else process.env.OPENARCH_BASE_DIR = previous;
    }
  }));

  it("缺文件与坏 YAML 给出不同的原因（不再压成同一句话）", () => withTemporaryDirectory("config-parity", async (dir) => {
    mkdirSync(join(dir, ".openarch"), { recursive: true });
    const previous = process.env.OPENARCH_BASE_DIR;
    process.env.OPENARCH_BASE_DIR = join(dir, ".openarch");
    try {
      const missing = loadAuthorityHygieneConfig().qualityErrors.join(" ");
      const missingPolicy = loadProtectedPathPolicy().errors.join(" ");
      expect(missing).toContain("does not exist");
      expect(missingPolicy).toContain("does not exist");

      writeFileSync(join(dir, ".openarch", "config.yml"), malformed);
      const invalid = loadAuthorityHygieneConfig().qualityErrors.join(" ");
      expect(invalid).not.toContain("does not exist");
      expect(invalid).toContain("duplicated mapping key");
    } finally {
      if (previous === undefined) delete process.env.OPENARCH_BASE_DIR;
      else process.env.OPENARCH_BASE_DIR = previous;
    }
  }));
});
