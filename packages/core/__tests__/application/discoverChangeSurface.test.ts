import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { changeSurfaceFactsFor } from "../../src/application/discover";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { ParserService } from "../../src/port/ParserService";
import { withGitRepo } from "../support/tsProject";

const parser = () =>
  Effect.runSync(Effect.gen(function* () {
    return yield* ParserService;
  }).pipe(Effect.provide(TreeSitterParserLive)));

describe("discover change mode (change-surface.v1)", () => {
  it("injects changedSymbols and hunk containers from the worktree change set", async () => {
    await withGitRepo([
      { path: "src/lib.ts", content: "export class Service {\n  run() {\n    return load();\n  }\n}\nfunction load() { return true; }\n" },
    ], async (cwd) => {
      // 方法体内变更：动态 import 行（应归属到 run 方法）
      writeFileSync(join(cwd, "src", "lib.ts"), "export class Service {\n  run() {\n    return import(`./plugins/load`);\n  }\n}\nfunction load() { return true; }\n");
      const result = await Effect.runPromise(changeSurfaceFactsFor(cwd, "worktree", parser()));

      expect(result.files).toEqual(["src/lib.ts"]);
      expect(result.changeSurface?.availability).toBe("available");
      const surface = result.changeSurface;
      if (surface?.availability !== "available") throw new Error("changeSurface should be available");
      expect(surface.value.changedSymbols.length).toBeGreaterThan(0);
      expect(surface.value.changedSymbols[0]!.file).toBe("src/lib.ts");
      // 文件内具体变更部分（hunk 级）：after 含变更后的行内容
      const fileChange = surface.value.changes.find((c) => c.file === "src/lib.ts");
      expect(fileChange?.hunks.length).toBeGreaterThan(0);
      expect(fileChange?.hunks[0]!.after.join("\n")).toContain("import(`./plugins/load`)");
      expect(fileChange?.hunks[0]!.before.join("\n")).toContain("return load();");
      // 语义容器：变更行在 run 方法内（方法优先于类——最小包含）
      expect(fileChange?.hunks[0]!.container).toEqual({ name: "run", kind: "method" });
    });
  });

  it("attributes hunks to containers for python (multi-language entry)", async () => {
    await withGitRepo([
      { path: "src/service.py", content: "class Service:\n    def run(self):\n        return load()\n\ndef load():\n    return True\n" },
    ], async (cwd) => {
      // run 方法体内变更（动态 importlib 引用）
      writeFileSync(join(cwd, "src", "service.py"), "class Service:\n    def run(self):\n        return importlib.import_module(\"plugins.load\")\n\ndef load():\n    return True\n");
      const result = await Effect.runPromise(changeSurfaceFactsFor(cwd, "worktree", parser()));

      const surface = result.changeSurface;
      if (surface?.availability !== "available") throw new Error("changeSurface should be available");
      const fileChange = surface.value.changes.find((c) => c.file === "src/service.py");
      expect(fileChange?.hunks[0]!.after.join("\n")).toContain("importlib.import_module");
      // Python 容器：def run 在 class 内——最小包含归属 run（kind=function）
      expect(fileChange?.hunks[0]!.container).toEqual({ name: "run", kind: "function" });
    }, { configYaml: 'languages: ["python"]\n' });
  });

  it("reports unavailable for a clean worktree", async () => {
    await withGitRepo([
      { path: "src/lib.ts", content: "export const value = true;\n" },
    ], async (cwd) => {
      const result = await Effect.runPromise(changeSurfaceFactsFor(cwd, "worktree", parser()));

      expect(result.files).toEqual([]);
      expect(result.changeSurface?.availability).toBe("unavailable");
    });
  });
});
