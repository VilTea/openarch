import { describe, expect, it } from "vitest";
import { isTypeScriptRevisionConfig, symbolRevisionSupportPaths } from "../../src/symbol-use/revisionSupport";

describe("symbol revision support manifest", () => {
  it("selects only declared language support files plus project classification", () => {
    const paths = [
      ".openarch/config.yml", "tsconfig.json", "packages/app/tsconfig.build.json", "package.json",
      "pyproject.toml", "pyrightconfig.json", "go.mod", "go.sum", "Cargo.toml", "pom.xml", "README.md",
    ];

    expect(symbolRevisionSupportPaths(["typescript", "python"], paths)).toEqual([
      ".openarch/config.yml", "tsconfig.json", "packages/app/tsconfig.build.json", "package.json", "pyproject.toml", "pyrightconfig.json",
    ]);
    expect(symbolRevisionSupportPaths(["go", "rust", "java"], paths)).toEqual([
      ".openarch/config.yml", "go.mod", "go.sum", "Cargo.toml", "pom.xml",
    ]);
  });

  it("keeps TypeScript extends traversal scoped to tsconfig files", () => {
    expect(isTypeScriptRevisionConfig("packages/app/tsconfig.build.json")).toBe(true);
    expect(isTypeScriptRevisionConfig("config/base.json")).toBe(false);
    expect(isTypeScriptRevisionConfig("pyrightconfig.json")).toBe(false);
  });
});
