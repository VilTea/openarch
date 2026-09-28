import { describe, expect, it } from "vitest";
import {
  selectTestGovernanceAdapters, suggestTestGovernanceAdapters,
} from "../../src/application/testGovernanceSetup";
import { testGovernanceProviders, testGovernanceRunners } from "../../src/test-governance/catalog";

/**
 * 回归（2026-09-25 实地核实，`.research/openarch-java-junit`）：
 * 报告给出的"适配器建议"曾指向不存在的 id（`junit` / `rust-cargo-test`），
 * 用户照抄建议即触发 `selectTestGovernanceAdapters` 的未知 adapter 分支，
 * 结果是**报告自己给的建议把自己判 BLOCK**（覆盖 0/N、spans UNAVAILABLE）。
 *
 * 合同：建议是给人/Agent 照抄进 config.yml 的，因此**建议的每个 id 必须可解析**。
 */
const SUPPORTED_LANGUAGES = ["typescript", "javascript", "vue", "go", "rust", "python", "java"] as const;

describe("suggestTestGovernanceAdapters（建议必须可执行）", () => {
  it.each(SUPPORTED_LANGUAGES)("suggests only registered adapter ids for %s", (language) => {
    const suggestion = suggestTestGovernanceAdapters([language]);
    expect(suggestion).toBeDefined();
    for (const id of suggestion?.providers ?? []) expect(Object.keys(testGovernanceProviders)).toContain(id);
    for (const id of suggestion?.runners ?? []) expect(Object.keys(testGovernanceRunners)).toContain(id);
  });

  it("carries no selection error when the suggestion is written back verbatim", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const suggestion = suggestTestGovernanceAdapters([language]);
      const selection = selectTestGovernanceAdapters(suggestion?.providers ?? [], suggestion?.runners ?? []);
      expect(selection.errors).toEqual([]);
    }
  });

  it("keeps the multi-language merge free of unknown ids", () => {
    const suggestion = suggestTestGovernanceAdapters([...SUPPORTED_LANGUAGES]);
    const selection = selectTestGovernanceAdapters(suggestion?.providers ?? [], suggestion?.runners ?? []);
    expect(selection.errors).toEqual([]);
    expect(selection.providers.length).toBeGreaterThan(0);
  });

  it("does not guess a JVM runner: Maven vs Gradle is a project decision, not a language fact", () => {
    expect(suggestTestGovernanceAdapters(["java"])?.runners).toEqual([]);
  });
});
