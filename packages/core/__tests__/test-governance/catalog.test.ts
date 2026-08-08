import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultScriptAssets } from "../../src/script-runtime/defaultScriptAssets";
import { testGovernanceProviders, testGovernanceRunners } from "../../src/test-governance/catalog";

const idsExportedFrom = (relativeDirectory: string, suffix: string): string[] =>
  readdirSync(resolve(process.cwd(), relativeDirectory))
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) => [...readFileSync(join(resolve(process.cwd(), relativeDirectory), file), "utf8")
      .matchAll(new RegExp(`export const [A-Z_]+_${suffix}_ID = ["']([^"']+)["']`, "g"))]
      .map((match) => match[1]))
    .sort();

describe("test-governance catalog", () => {
  it("registers every provider and runner module exported from the supported directories", () => {
    expect(Object.keys(testGovernanceProviders).sort()).toEqual(idsExportedFrom("src/test-governance/providers", "PROVIDER"));
    expect(Object.keys(testGovernanceRunners).sort()).toEqual(idsExportedFrom("src/test-governance/runners", "RUNNER"));
  });

  it("resolves every manifest test-governance runtime id through the matching catalog", () => {
    for (const asset of defaultScriptAssets().filter((asset) => asset.engine === "test-governance")) {
      const catalog = asset.kind === "provider" ? testGovernanceProviders : testGovernanceRunners;
      expect(asset.runtimeId, `${asset.id} must declare runtime_id`).toBeDefined();
      expect(catalog[asset.runtimeId!], `${asset.id} runtime_id must be registered`).toBeDefined();
    }
  });
});
