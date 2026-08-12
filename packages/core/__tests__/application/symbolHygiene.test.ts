import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { prefilterStaticBoundEmpty, staticConsumerFilesFor } from "../../src/application/symbolHygiene";
import { StorageService, type IndexEntry } from "../../src/port/StorageService";
import { toAbsolute } from "../../src/infra/paths";

const entry = (inDegree: number): IndexEntry => ({
  path: "src/api.ts", language: "typescript", fileKind: "production",
  branchCount: 1, nestingDepth: 1, inDegree, outDegree: 1, alphaStruct: 0.1,
});

const storageWith = (metrics: Record<string, IndexEntry | null>, all: ReadonlyArray<readonly [string, IndexEntry]> = []) =>
  Layer.succeed(StorageService, {
    readFileMetrics: (path: string) => Effect.succeed(metrics[path] ?? null),
    listAllFileMetrics: () => Effect.succeed(all),
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

  it("多文件变更集内 inDegree=0 的文件保守保留（变更文件互相 import 会改 inDegree）", async () => {
    const profiles = [
      { file: "src/a.ts", beforeState: "git" as const, changes: [{ anchor: "x", kind: "function_body" }] },
      { file: "src/b.ts", beforeState: "git" as const, changes: [{ anchor: "x", kind: "function_body" }] },
    ];
    const kept = await run(profiles, { [toAbsolute("src/a.ts")]: entry(0), [toAbsolute("src/b.ts")]: entry(0) });
    expect(kept).toEqual(profiles);
  });

  it("配置 implicitDeps 时 inDegree=0 的文件保守保留（baseline 不含最新隐式边）", async () => {
    const profile = { file: "src/consumer.ts", beforeState: "git" as const, changes: [{ anchor: "x", kind: "function_body" }] };
    const kept = await Effect.runPromise(
      prefilterStaticBoundEmpty([profile], { implicitDeps: [{ from: "src/api.ts", to: "src/consumer.ts", via: "kafka:topic", type: "message_queue" }] })
        .pipe(Effect.provide(storageWith({ [toAbsolute("src/consumer.ts")]: entry(0) }))),
    );
    expect(kept).toEqual([profile]);
  });

  it("Go 同包文件 inDegree=0 保守保留（同目录有其他 .go 文件时可能有同包消费者）", async () => {
    const profile = { file: "src/pkg/util.go", beforeState: "git" as const, changes: [{ anchor: "x", kind: "function_body" }] };
    const goEntry: IndexEntry = { ...entry(0), path: "src/pkg/util.go" };
    const kept = await Effect.runPromise(
      prefilterStaticBoundEmpty([profile]).pipe(Effect.provide(storageWith(
        { [toAbsolute("src/pkg/util.go")]: goEntry },
        [
          ["src/pkg/util.go", goEntry],
          ["src/pkg/main.go", { ...entry(0), path: "src/pkg/main.go" }],
        ],
      ))),
    );
    expect(kept).toEqual([profile]);
  });

  it("Go 单文件目录 inDegree=0 仍剔除（无同包消费者可能）", async () => {
    const profile = { file: "src/standalone/util.go", beforeState: "git" as const, changes: [{ anchor: "x", kind: "function_body" }] };
    const goEntry: IndexEntry = { ...entry(0), path: "src/standalone/util.go" };
    const kept = await Effect.runPromise(
      prefilterStaticBoundEmpty([profile]).pipe(Effect.provide(storageWith(
        { [toAbsolute("src/standalone/util.go")]: goEntry },
        [["src/standalone/util.go", goEntry]],
      ))),
    );
    expect(kept).toEqual([]);
  });
});

describe("staticConsumerFilesFor（静态消费者候选，2026-08-12 修复）", () => {
  it("matches baseline relative imports against relative target paths", async () => {
    // baseline 持久化 imports 为相对路径（baselineEntry toRelative），targets
    // 也统一转相对（toRelative）——以相对路径为准，跨机器/checkout 一致。
    const consumer: IndexEntry = {
      ...entry(0),
      path: "src/consumer.ts",
      imports: ["src/api.ts"],
    };
    const all: ReadonlyArray<readonly [string, IndexEntry]> = [["src/consumer.ts", consumer]];
    const result = await Effect.runPromise(
      staticConsumerFilesFor([{ file: toAbsolute("src/api.ts"), changes: [], beforeState: "baseline" }])
        .pipe(Effect.provide(storageWith({}, all))),
    );
    expect(result).toEqual(["src/consumer.ts"]);
  });

  it("returns empty when no baseline file imports the target", async () => {
    const all: ReadonlyArray<readonly [string, IndexEntry]> = [["src/other.ts", { ...entry(0), path: "src/other.ts", imports: ["src/unrelated.ts"] }]];
    const result = await Effect.runPromise(
      staticConsumerFilesFor([{ file: toAbsolute("src/api.ts"), changes: [], beforeState: "baseline" }])
        .pipe(Effect.provide(storageWith({}, all))),
    );
    expect(result).toEqual([]);
  });
});
