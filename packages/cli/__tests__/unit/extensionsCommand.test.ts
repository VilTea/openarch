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

  it("filters facts by domain and shows installed-script consumers", async () => {
    const result = await captureOutput(() => extensionsCommand(["--facts", "--domain", "ast"], {
      cwd: resolve(process.cwd(), "../.."), rawArgv: [], locale: "zh",
    }));
    expect(result.code).toBe(0);
    expect(result.output).toContain("string-key-calls-ts-js.v1");
    expect(result.output).toContain("曾用: string-key-calls.v1");
    expect(result.output).toContain("consumers=1");
    expect(result.output).toContain("static-imports.v1");
    expect(result.output).not.toContain("file-classification.v1");
  });

  it("exposes the self-describing rules-facts-json-v1 contract", async () => {
    const result = await captureOutput(() => extensionsCommand(["--facts", "--domain", "semantic", "--json"], {
      cwd: resolve(process.cwd(), "../.."), rawArgv: [], locale: "en",
    }));
    expect(result.code).toBe(0);
    const json = JSON.parse(result.output);
    expect(json.schema).toBe("rules-facts-json-v1");
    expect(json.facts.map((fact: { id: string }) => fact.id)).toEqual([
      "invocation-bindings.v1",
      "semantic-relations.v1",
    ]);
    for (const fact of json.facts) {
      expect(fact.domain).toBe("semantic");
      expect(typeof fact.usage).toBe("string");
      expect(fact.outputs.length).toBeGreaterThan(0);
      expect(typeof fact.consumers.requires).toBe("number");
      expect(typeof fact.consumers.astFact).toBe("number");
      expect(Array.isArray(fact.builtinConsumers)).toBe(true);
      expect(typeof fact.lifecycle).toBe("string");
    }
  });

  it("supports --query and --unused search over self-descriptions", async () => {
    const unused = await captureOutput(() => extensionsCommand(["--facts", "--query", "string-key", "--unused"], {
      cwd: resolve(process.cwd(), "../.."), rawArgv: [], locale: "zh",
    }));
    expect(unused.code).toBe(0);
    expect(unused.output).toContain("没有匹配");

    const hit = await captureOutput(() => extensionsCommand(["--facts", "--query", "string-key"], {
      cwd: resolve(process.cwd(), "../.."), rawArgv: [], locale: "zh",
    }));
    expect(hit.code).toBe(0);
    expect(hit.output).toContain("string-key-calls-ts-js.v1");
  });

  it("rejects malformed facts options with usage", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await extensionsCommand(["--facts", "--domain"], { cwd: resolve(process.cwd(), "../.."), rawArgv: [], locale: "zh" });
    expect(code).toBe(3);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("rules facts"));
    error.mockRestore();
  });

  it("keeps zero-consumer facts report-only when every one explains its lifecycle", async () => {
    const result = await captureOutput(() => extensionsCommand(["--check", "--unused"], {
      cwd: resolve(process.cwd(), "../.."), rawArgv: [], locale: "zh",
    }));
    expect(result.code).toBe(0);
    expect(result.output).toContain("零消费者事实");
    expect(result.output).toContain("structure-metrics.v1");
    expect(result.output).toContain("invocation-bindings.v1");
    expect(result.output).toContain("semantic-relations.v1");
    expect(result.output).toContain("2026-");
    expect(result.output).not.toContain("change-surface.v1");
  });
});
