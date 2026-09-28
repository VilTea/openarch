import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { OPENARCH_VERSION } from "../../src/version";

// 清单从**测试文件自身位置**求相对路径（此前是相对 `process.cwd()` 的裸路径
// `"package.json"` / `"../core/package.json"`，只在"包目录为 cwd"时成立，换个 cwd 即 ENOENT 假失败）。
const manifest = (url: URL): { readonly version?: string; readonly dependencies?: Readonly<Record<string, string>> } =>
  JSON.parse(readFileSync(url, "utf8")) as { readonly version?: string; readonly dependencies?: Readonly<Record<string, string>> };

const cliManifest = new URL("../../package.json", import.meta.url);
const coreManifest = new URL("../../../core/package.json", import.meta.url);

describe("local release dependency contract", () => {
  it("declares every core runtime dependency from the CLI distribution root", () => {
    const core = manifest(coreManifest);
    const cli = manifest(cliManifest);
    for (const [name, version] of Object.entries(core.dependencies ?? {})) {
      expect(cli.dependencies?.[name]).toBe(version);
    }
  });

  it("reads calibration evidence version from the packaged CLI manifest", () => {
    expect(OPENARCH_VERSION).toBe(manifest(cliManifest).version);
  });
});
