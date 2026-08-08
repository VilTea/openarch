import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { OPENARCH_VERSION } from "../../src/version";

const manifest = (path: string): { readonly version?: string; readonly dependencies?: Readonly<Record<string, string>> } =>
  JSON.parse(readFileSync(path, "utf8")) as { readonly version?: string; readonly dependencies?: Readonly<Record<string, string>> };

describe("local release dependency contract", () => {
  it("declares every core runtime dependency from the CLI distribution root", () => {
    const core = manifest("../core/package.json");
    const cli = manifest("package.json");
    for (const [name, version] of Object.entries(core.dependencies ?? {})) {
      expect(cli.dependencies?.[name]).toBe(version);
    }
  });

  it("reads calibration evidence version from the packaged CLI manifest", () => {
    expect(OPENARCH_VERSION).toBe(manifest("package.json").version);
  });
});
