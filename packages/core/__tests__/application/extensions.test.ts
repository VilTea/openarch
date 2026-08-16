import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { checkExtensionContracts, scriptFactConsumers } from "../../src/application/extensions";

const root = join(tmpdir(), `openarch-extension-contracts-${Date.now()}`);
const directories = {
  "anti-patterns": join(root, "anti-patterns"),
  "implicit-deps": join(root, "implicit-deps"),
  "test-governance": join(root, "test-governance"),
};

const write = (engine: keyof typeof directories, name: string): string => {
  mkdirSync(directories[engine], { recursive: true });
  const path = join(directories[engine], name);
  writeFileSync(path, "// module supplied by the test importer");
  return path;
};

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("checkExtensionContracts", () => {
  it("accepts all three project-script contracts without executing callbacks", async () => {
    const anti = write("anti-patterns", "anti.mjs");
    const deps = write("implicit-deps", "deps.mjs");
    const tests = write("test-governance", "tests.mjs");
    const modules = new Map([
      [pathToFileURL(anti).href, { default: { scope: "file", stages: {}, link: () => { throw new Error("must not execute"); } } }],
      [pathToFileURL(deps).href, { default: { stages: {}, link: () => { throw new Error("must not execute"); } } }],
      [pathToFileURL(tests).href, { default: { stages: {}, link: () => { throw new Error("must not execute"); } } }],
    ]);

    const report = await checkExtensionContracts({
      directories,
      importFn: async (url) => modules.get(url) ?? {},
    });

    expect(report).toMatchObject({ checked: 3, byEngine: { "anti-patterns": 1, "implicit-deps": 1, "test-governance": 1 }, issues: [] });
  });

  it("reports a retired named export as invalid without running it", async () => {
    const path = write("test-governance", "legacy.mjs");
    const report = await checkExtensionContracts({
      directories,
      importFn: async (url) => url === pathToFileURL(path).href ? { detect: () => [] } : {},
    });

    expect(report.issues).toEqual([expect.objectContaining({ engine: "test-governance", path, error: expect.stringContaining("必须 export default") })]);
  });

  it("allows declaring unknown fact domains (open registry; runtime decides availability)", async () => {
    const path = write("implicit-deps", "unknown-fact.mjs");
    const report = await checkExtensionContracts({
      directories,
      importFn: async (url) => url === pathToFileURL(path).href
        ? { default: { requires: ["invented-fact.v1"], stages: {}, link: () => [] } }
        : {},
    });
    // 开放域：未知 capability 不再被契约层拒绝——脚本可声明，运行时按注册表判 unavailable
    expect(report.issues).toEqual([]);
  });

  it("collects installed-script fact consumption for requires and ast facts without executing link", async () => {
    const anti = write("anti-patterns", "authority.mjs");
    const deps = write("implicit-deps", "cordis.mjs");
    const modules = new Map([
      [pathToFileURL(anti).href, { default: { requires: ["authorities.v1"], stages: {}, link: () => { throw new Error("must not execute"); } } }],
      [pathToFileURL(deps).href, { default: { stages: { ast: { fact: "string-key-calls.v1" } }, link: () => { throw new Error("must not execute"); } } }],
    ]);

    const consumers = await scriptFactConsumers({
      directories,
      importFn: async (url) => modules.get(url) ?? {},
    });

    expect(consumers["authorities.v1"]).toMatchObject({ requires: 1, astFact: 0, files: [anti] });
    // 旧 id 归一化到带语言标识的规范 id。
    expect(consumers["string-key-calls-ts-js.v1"]).toMatchObject({ requires: 0, astFact: 1, files: [deps] });
    expect(consumers["string-key-calls.v1"]).toBeUndefined();
  });
});
