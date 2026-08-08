import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isAntiPatternRule } from "../../src/anti-patterns/engine";
import { isImplicitDependencyRule } from "../../src/implicit-deps/engine";

interface AssetEntry {
  readonly engine: "anti-patterns" | "implicit-deps" | "test-governance" | "configuration";
  readonly source?: string;
  readonly languages?: readonly string[];
  readonly kind: "script" | "parameterized-template" | "provider" | "configuration-template";
}

const templateRoot = resolve(process.cwd(), "assets/templates");
const manifest = JSON.parse(readFileSync(resolve(templateRoot, "default-scripts.json"), "utf8")) as { entries: AssetEntry[] };

const importTemplate = async (path: string) => {
  const source = readFileSync(path, "utf8").replace(/\{\{[A-Za-z0-9_]+\}\}/g, "placeholder");
  return import(`data:text/javascript,${encodeURIComponent(source)}`);
};

describe("default extension assets", () => {
  it("keeps shipped sources in common or language-scoped directories", () => {
    const languageDirectories = new Map([
      ["typescript", "typescript"], ["javascript", "typescript"], ["python", "python"], ["go", "go"], ["rust", "rust"], ["java", "java"],
    ]);
    for (const asset of manifest.entries.filter((entry) => entry.source)) {
      const directory = asset.source!.split("/", 1)[0];
      expect(["common", ...new Set(languageDirectories.values())]).toContain(directory);
      if (directory !== "common") {
        expect(asset.languages?.some((language) => languageDirectories.get(language) === directory)).toBe(true);
      }
    }
  });

  it("exports the contract required by every shipped script and template", async () => {
    const assets = manifest.entries.filter((entry) => entry.kind === "script" || entry.kind === "parameterized-template");
    expect(assets.length).toBeGreaterThan(0);

    for (const asset of assets) {
      expect(asset.source).toBeDefined();
      const path = resolve(templateRoot, asset.source!);
      const module = asset.kind === "script" ? await import(pathToFileURL(path).href) : await importTemplate(path);
      if (asset.engine === "anti-patterns") expect(isAntiPatternRule(module.default)).toBe(true);
      if (asset.engine === "implicit-deps") expect(isImplicitDependencyRule(module.default)).toBe(true);
    }
  });
});
