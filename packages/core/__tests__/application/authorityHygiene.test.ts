import { describe, expect, it } from "vitest";
import { evaluateAuthorityHygieneQuality, parseAuthorityHygieneConfig } from "../../src/application/authorityHygiene";

const config = parseAuthorityHygieneConfig({
  authority_hygiene: {
    authorities: [{ id: "script-runtime", owner: "src/runtime.ts" }],
    quality_rules: { "authority-import-bypass.mjs": "block" },
  },
});

describe("authority hygiene quality policy", () => {
  it("promotes only explicitly selected authority-backed scripts", () => {
    const reportOnly = evaluateAuthorityHygieneQuality([{
      source: "unrelated.mjs", scope: "repository", ruleId: "other", file: "src/a.ts", message: "other",
    }], config, ["authority-import-bypass.mjs", "unrelated.mjs"], []);
    const blocked = evaluateAuthorityHygieneQuality([{
      source: "authority-import-bypass.mjs", scope: "repository", ruleId: "authority-import-bypass", file: "src/a.ts", message: "bypass",
    }], config, ["authority-import-bypass.mjs"], []);
    expect(reportOnly.verdict).toBe("PASS");
    expect(blocked.verdict).toBe("BLOCK");
  });

  it("fails closed when a selected authority rule was absent or unavailable", () => {
    const absent = evaluateAuthorityHygieneQuality([], config, [], []);
    const unavailable = evaluateAuthorityHygieneQuality([], config, ["authority-import-bypass.mjs"], [{
      source: "authority-import-bypass.mjs", kind: "error", message: "invalid script",
    }]);
    expect(absent).toMatchObject({ verdict: "BLOCK", unavailable: [expect.stringContaining("not executed")] });
    expect(unavailable).toMatchObject({ verdict: "BLOCK", unavailable: [expect.stringContaining("invalid script")] });
  });

  it("rejects malformed quality rules instead of treating them as report-only", () => {
    const invalid = parseAuthorityHygieneConfig({ authority_hygiene: { quality_rules: { "rule.ts": "block" } } });
    expect(invalid.qualityConfigured).toBe(true);
    expect(invalid.qualityErrors).toHaveLength(1);
  });
});
