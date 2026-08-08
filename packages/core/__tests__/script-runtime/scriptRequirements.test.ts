import { describe, expect, it } from "vitest";
import { requestedScriptCapabilities } from "../../src/script-runtime/scriptRequirements";
import { createProjectFacts, unavailableRequiredFact } from "../../src/script-runtime/projectFacts";
import { scriptDomainResult } from "../../src/script-runtime/factDomains";

describe("requestedScriptCapabilities", () => {
  it("loads declared requirements including unknown domains (open registry; runtime decides availability)", async () => {
    await expect(requestedScriptCapabilities(["semantic.mjs", "invalid.mjs"], async (url) =>
      url.includes("semantic.mjs")
        ? { default: { requires: ["semantic-relations.v1", "structure-metrics.v1"] } }
        : { default: { requires: ["unknown.v1"] } },
    )).resolves.toEqual([
      "semantic-relations.v1",
      "structure-metrics.v1",
      "unknown.v1",
    ]);
  });

  it("resolves stable domain names and .v1 suffixes through the registry, and reports unknown domains as unavailable", () => {
    const facts = createProjectFacts({ files: ["src/a.ts"], projectRoot: "/repo" });
    // 稳定名（无 .v1）与 .v1 后缀都解析到同一域
    expect(scriptDomainResult(facts, "file-classification")).toMatchObject({ availability: "available" });
    expect(scriptDomainResult(facts, "structure-metrics")).toMatchObject({ availability: "unavailable" });
    // unavailableRequiredFact 兼容两种写法
    expect(unavailableRequiredFact(["file-classification"], facts)).toBeUndefined();
    expect(unavailableRequiredFact(["structure-metrics"], facts)).toContain("unavailable");
    // 未注册域：可声明但运行时 unavailable
    expect(scriptDomainResult(facts, "future-domain")).toBeUndefined();
    expect(unavailableRequiredFact(["future-domain"], facts)).toContain("unavailable");
  });
});
