import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { extensionsCommand } from "../../src/commands/extensions";

const captureOutput = async (run: () => Promise<number>): Promise<{ code: number; output: string }> => {
  const output: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { output.push(line); });
  try {
    return { code: await run(), output: output.join("\n") };
  } finally {
    spy.mockRestore();
  }
};

describe("extensions command guidance", () => {
  it("lists public fact capabilities without inspecting project scripts", async () => {
    const result = await captureOutput(() => extensionsCommand(["--facts"], {
      cwd: resolve(process.cwd(), "../.."), rawArgv: [],
    }));
    expect(result.code).toBe(0);
    expect(result.output).toContain("structure-metrics.v1");
    expect(result.output).toContain("protectedFiles/authorityIds");
    expect(result.output).toContain("Skeletons:");
    expect(result.output).toContain("可选反模式模板");
    expect(result.output).toContain("placeholder-implementation");
  });

  it("prints a requested starter without writing into the project", async () => {
    const result = await captureOutput(() => extensionsCommand(["--skeleton", "metrics"]));
    expect(result.code).toBe(0);
    expect(result.output).toContain('requires: ["structure-metrics.v1"]');
  });
});
