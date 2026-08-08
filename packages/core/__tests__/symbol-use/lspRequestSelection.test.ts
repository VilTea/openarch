import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { selectSymbolUseDemand } from "../../src/symbol-use/demand";
import { selectByKeyWaves, selectSupportingFiles } from "../../src/adapter/symbol-use/LspRequestSelection";

describe("LSP request selection", () => {
  it("covers each key before returning to an earlier key", () => {
    const selected = selectByKeyWaves([
      { key: "alpha", value: "a1" },
      { key: "alpha", value: "a2" },
      { key: "alpha", value: "a3" },
      { key: "beta", value: "b1" },
      { key: "gamma", value: "c1" },
    ], 4, (item) => item.key);

    expect(selected.map((item) => item.value)).toEqual(["a1", "b1", "c1", "a2"]);
  });

  it("keeps selected declaration files inside a bounded document population", () => {
    const files = Array.from({ length: 10 }, (_, index) => `file-${index}`);
    const selected = selectSupportingFiles(files, ["file-9"], 3);

    expect(selected).toHaveLength(3);
    expect(selected).toContain("file-9");
  });

  it("keeps only governed named declarations in a revision demand", () => {
    const cwd = resolve("workspace");
    const selection = selectSymbolUseDemand(cwd, [resolve(cwd, "src/api.go")], {
      declarations: [
        { file: "src/api.go", names: ["publish"] },
        { file: "fixtures/input.go", names: ["ignored"] },
      ],
    });

    expect(selection).toMatchObject({
      declarationFiles: [resolve(cwd, "src/api.go")],
      reason: expect.stringContaining("selected 1/1"),
    });
    expect(selection.namesByFile?.get(resolve(cwd, "src/api.go"))).toEqual(new Set(["publish"]));
  });
});
