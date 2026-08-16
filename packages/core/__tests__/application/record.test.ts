import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Layer } from "effect";
import { record } from "../../src/application/record";
import { StorageService } from "../../src/port/StorageService";

describe("record", () => {
  it("uses sealed history instead of a CRL cache from the baseline entry", async () => {
    const root = join(tmpdir(), `openarch-record-${Date.now()}`);
    const docs = join(root, "docs");
    mkdirSync(docs, { recursive: true });
    const StorageTest = Layer.succeed(StorageService, {
      readIndex: () => Effect.succeed({ version: "5.2", meta: { scanAt: "2026-07-18T00:00:00.000Z", nFiles: 1, languages: ["typescript"] } }),
      listAllFileMetrics: () => Effect.succeed([
        ["src/a.ts", { path: "src/a.ts", branchCount: 1, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0, maxFuncBranch: 2 }],
        ["fixtures/noisy.ts", { path: "fixtures/noisy.ts", fileKind: "auxiliary", branchCount: 99, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0, maxFuncBranch: 99 }],
      ]),
      readAllHistory: () => Effect.succeed([["2026-07-18T00:00:00.000Z", [{ file: "src/a.ts", deltaI: 9 }, { file: "fixtures/noisy.ts", deltaI: 900 }]]]),
    });
    const result = await Effect.runPromise(record({ title: "history fact", docsDir: docs, now: new Date("2026-07-18T00:00:00.000Z") }).pipe(Effect.provide(StorageTest)));
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(readFileSync(result.filePath, "utf8")).toContain("src/a.ts (CRL=9.0, maxFuncBranch=2)");
  });

  it("renders an English template when the caller requests the en locale", async () => {
    const root = join(tmpdir(), `openarch-record-en-${Date.now()}`);
    const docs = join(root, "docs");
    mkdirSync(docs, { recursive: true });
    const StorageTest = Layer.succeed(StorageService, {
      readIndex: () => Effect.succeed(null), listAllFileMetrics: () => Effect.succeed([]), readAllHistory: () => Effect.succeed([]),
    });
    const result = await Effect.runPromise(record({
      title: "localized fact", docsDir: docs, locale: "en", now: new Date("2026-07-18T00:00:00.000Z"),
    }).pipe(Effect.provide(StorageTest)));
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const content = readFileSync(result.filePath, "utf8");
    expect(content).toContain("Source: openarch docs record");
    expect(content).toContain("<!-- REQUIRED:");
    expect(content).toContain("Highest historical CRL:");
  });

  it("confines titles to the category directory and never overwrites a record", async () => {
    const root = join(tmpdir(), `openarch-record-boundary-${Date.now()}`);
    const docs = join(root, "docs");
    mkdirSync(docs, { recursive: true });
    const StorageTest = Layer.succeed(StorageService, {
      readIndex: () => Effect.succeed(null), listAllFileMetrics: () => Effect.succeed([]), readAllHistory: () => Effect.succeed([]),
    });
    const first = await Effect.runPromise(record({ title: "../../outside", docsDir: docs, now: new Date("2026-07-18T00:00:00.000Z") }).pipe(Effect.provide(StorageTest)));
    expect("error" in first).toBe(false);
    if ("error" in first) return;
    expect(first.filePath.startsWith(resolve(docs))).toBe(true);
    expect(existsSync(join(root, "outside.md"))).toBe(false);
    const repeated = await Effect.runPromise(record({ title: "../../outside", docsDir: docs, now: new Date("2026-07-18T00:00:00.000Z") }).pipe(Effect.provide(StorageTest)));
    expect(repeated).toEqual({ error: "同名经验文档已存在，未覆盖；请更换标题" });
  });

  it("reports non-conflict filesystem failures as write failures", async () => {
    const root = join(tmpdir(), `openarch-record-write-error-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const docsFile = join(root, "docs-file");
    writeFileSync(docsFile, "not a directory");
    const StorageTest = Layer.succeed(StorageService, {
      readIndex: () => Effect.succeed(null), listAllFileMetrics: () => Effect.succeed([]), readAllHistory: () => Effect.succeed([]),
    });

    try {
      const result = await Effect.runPromise(record({ title: "write failure", docsDir: docsFile, now: new Date("2026-07-18T00:00:00.000Z") }).pipe(Effect.provide(StorageTest)));
      expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining("经验文档写入失败") }));
      expect(result).not.toEqual({ error: "同名经验文档已存在，未覆盖；请更换标题" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
