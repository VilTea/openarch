import { describe, expect, it, vi } from "vitest";
import { contractCommand } from "../../src/commands/contract";

describe("contract command", () => {
  it("prints the machine contract catalog as stable JSON", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(contractCommand(["--json"], { cwd: process.cwd(), rawArgv: [], locale: "zh" })).resolves.toBe(0);

    const json = JSON.parse(String(output.mock.calls[0][0]));
    expect(json.schema).toBe("contract-catalog-json-v1");
    expect(json.openarchVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(json.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "context-json", version: "context-json-v1", status: "current" }),
      expect.objectContaining({ id: "test-governance-json", version: "test-governance-json-v1", status: "current" }),
      expect.objectContaining({ id: "test-governance-provider-list-json", version: "test-governance-provider-list-v1", status: "current" }),
      expect.objectContaining({ id: "rules-facts-json", version: "rules-facts-json-v1", status: "current" }),
      expect.objectContaining({ id: "docs-check-json", version: "docs-check-json-v1", status: "current" }),
    ]));
  });

  it("renders the catalog through i18n and rejects unknown flags", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(contractCommand([], { cwd: process.cwd(), rawArgv: [], locale: "zh" })).resolves.toBe(0);
    const zh = output.mock.calls.map(([line]) => String(line)).join("\n");
    expect(zh).toContain("机器契约目录");
    expect(zh).toContain("context-json: context-json-v1");

    output.mockClear();
    await expect(contractCommand([], { cwd: process.cwd(), rawArgv: [], locale: "en" })).resolves.toBe(0);
    const en = output.mock.calls.map(([line]) => String(line)).join("\n");
    expect(en).toContain("Machine Contract Catalog");
    expect(en).not.toMatch(/[\p{Script=Han}]/u);

    await expect(contractCommand(["--bogus"], { cwd: process.cwd(), rawArgv: [], locale: "zh" })).resolves.toBe(3);
    expect(error).toHaveBeenCalled();
  });
});
