import { describe, expect, it } from "vitest";
import { isAntiPatternRule } from "../../src/anti-patterns/engine";
import { readDefaultScriptAsset, defaultScriptAssets } from "../../src/script-runtime/defaultScriptAssets";
import { SCRIPT_STARTERS, scriptStarter } from "../../src/script-runtime/scriptStarters";

describe("script starters", () => {
  it("projects every loadable starter from a manifest-backed template asset", async () => {
    const assets = defaultScriptAssets().filter((asset) => asset.kind === "starter");
    expect(SCRIPT_STARTERS.map((starter) => starter.id)).toEqual(assets.map((asset) => asset.starterId));
    for (const asset of assets) {
      const source = readDefaultScriptAsset(asset)!;
      expect(source).toBe(scriptStarter(asset.starterId!).source);
      expect((await import(`data:text/javascript,${encodeURIComponent(source)}`)).default).toBeDefined();
    }
  });

  it("emits an authority-import rule that prunes declared relative boundaries", async () => {
    const starter = scriptStarter("authority-import");
    expect(starter).toBeDefined();
    const module = await import(`data:text/javascript,${encodeURIComponent(starter!.source)}`);
    expect(isAntiPatternRule(module.default)).toBe(true);

    const candidates = module.default.stages.text({
      files: ["src/testing/runners/cargo.ts", "src/testing/providers/rust.ts"],
      text: (file: string) => file.endsWith("cargo.ts")
        ? 'import type { ParserService } from "../../port/ParserService";'
        : 'import { test } from "vitest";',
      facts: {
        authorities: {
          value: [{
            id: "execution",
            owner: "src/application/tests.ts",
            protectedPaths: ["src/testing/runners/"],
            prohibitedImports: ["../../port/ParserService"],
          }],
        },
      },
    });
    expect(candidates).toEqual(["src/testing/runners/cargo.ts"]);
  });
});
