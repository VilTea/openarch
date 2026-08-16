import { describe, expect, it } from "vitest";
import { machineContractDescriptors } from "../../src/domain/contractCatalog";

describe("machine contract catalog", () => {
  it("keeps ids and versions unique for current contracts", () => {
    const contracts = machineContractDescriptors();
    const ids = new Set(contracts.map((descriptor) => descriptor.id));
    const versions = new Set(contracts.map((descriptor) => descriptor.version));
    expect(contracts.length).toBe(5);
    expect(ids.size).toBe(contracts.length);
    expect(versions.size).toBe(contracts.length);
    expect(contracts.every((descriptor) => descriptor.status === "current")).toBe(true);
  });

  it("uses the v1 schema and versioned identifiers expected by external plugins", () => {
    const byId = Object.fromEntries(machineContractDescriptors().map((descriptor) => [descriptor.id, descriptor.version]));
    expect(byId).toEqual({
      "context-json": "context-json-v1",
      "test-governance-json": "test-governance-json-v1",
      "test-governance-provider-list-json": "test-governance-provider-list-v1",
      "rules-facts-json": "rules-facts-json-v1",
      "docs-check-json": "docs-check-json-v1",
    });
  });
});
