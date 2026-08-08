import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { prefilterStaticBoundEmpty } from "../../src/application/symbolHygiene";
import { StorageService, type IndexEntry } from "../../src/port/StorageService";
import { toAbsolute } from "../../src/infra/paths";

const entry = (inDegree: number): IndexEntry => ({
  path: "src/api.ts", language: "typescript", fileKind: "production",
  branchCount: 1, nestingDepth: 1, inDegree, outDegree: 1, alphaStruct: 0.1,
});

const storageWith = (metrics: Record<string, IndexEntry | null>) =>
  Layer.succeed(StorageService, {
    readFileMetrics: (path: string) => Effect.succeed(metrics[path] ?? null),
  });

const run = async (profiles: Array<{ file: string; beforeState: "git"; changes: readonly { anchor: string; kind: string }[] }>, metrics: Record<string, IndexEntry | null>) => {
  const result = await Effect.runPromise(prefilterStaticBoundEmpty(profiles).pipe(Effect.provide(storageWith(metrics))));
  return result;
};

describe("prefilterStaticBoundEmpty（静态上界预筛）", () => {
  it("inDegree=0 的变更文件被剔除（上界为空 → 无需 LSP）", async () => {
    const kept = await run(
      [{ file: "src/orphan.ts", beforeState: "git", changes: [{ anchor: "x", kind: "function_body" }] }],
      { [toAbsolute("src/orphan.ts")]: entry(0) },
    );
    expect(kept).toEqual([]);
  });

  it("inDegree>0 的变更文件保留（上界非空 → 需要 LSP 确认）", async () => {
    const profile = { file: "src/api.ts", beforeState: "git" as const, changes: [{ anchor: "x", kind: "function_body" }] };
    const kept = await run([profile], { [toAbsolute("src/api.ts")]: entry(3) });
    expect(kept).toEqual([profile]);
  });

  it("无 baseline entry（新增/未扫描）保守保留", async () => {
    const profile = { file: "src/new.ts", beforeState: "git" as const, changes: [{ anchor: "x", kind: "function_body" }] };
    const kept = await run([profile], {});
    expect(kept).toEqual([profile]);
  });
});
