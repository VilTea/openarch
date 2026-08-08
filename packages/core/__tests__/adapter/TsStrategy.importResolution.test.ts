import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { join, resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseTs } from "../../src/adapter/parser/TsStrategy";

const fixture = (name: string) => resolve(__dirname, "..", "..", "fixtures", name);

describe("TsStrategy import resolution", () => {
  it("解析 NodeNext 的运行时 .js 标识符到存在的 TS 源文件，同时保留真实 JS 文件", async () => {
    const ast = await Effect.runPromise(parseTs(fixture("node-next-import.ts")));
    const resolvedPath = (source: string) => ast.imports.find((entry) => entry.source === source)?.resolvedPath;

    expect(resolvedPath("./node-next-target.js")).toBe(fixture("node-next-target.ts"));
    expect(resolvedPath("./node-next-runtime.js")).toBe(fixture("node-next-runtime.js"));
    expect(resolvedPath("./extensionless-target")).toBe(fixture("extensionless-target.ts"));
    expect(resolvedPath("./missing.js")).toBeNull();
    expect(resolvedPath("effect")).toBeNull();
  }, 15000);

  it("按最近 tsconfig 的 module resolution 和 path mapping 解析本地模块", async () => {
    const dir = join(tmpdir(), `openarch-ts-resolver-${Date.now()}`);
    const sourceDir = join(dir, "src", "core");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        paths: { "@core/*": ["src/core/*"] },
      },
    }));
    writeFileSync(join(sourceDir, "value.ts"), "export const value = 1;");
    const mainPath = join(dir, "main.ts");
    writeFileSync(mainPath, 'import { value } from "@core/value";\nimport "./src/core/value.js";\nexport { value };');

    const ast = await Effect.runPromise(parseTs(mainPath));
    expect(ast.imports.map((entry) => entry.resolvedPath)).toEqual([
      join(sourceDir, "value.ts"),
      join(sourceDir, "value.ts"),
    ]);

    rmSync(dir, { recursive: true, force: true });
  }, 15000);
});
