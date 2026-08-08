import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { join } from "node:path";
import { executeStagedAnalysis } from "../../src/staged-analysis/engine";
import { emptyProjectFacts, type ProjectFacts } from "../../src/script-runtime/projectFacts";

const parser = {
  parse: (file: string) => Effect.succeed({} as never),
  query: (_file: string, _pattern: string) =>
    Effect.succeed([
      { startLine: 5, captures: [{ name: "fn", text: "import" }] },
      { startLine: 12, captures: [{ name: "fn", text: "import" }] },
    ] as never),
};

const factsWithChangeSurface = {
  ...emptyProjectFacts(),
  changeSurface: {
    availability: "available",
    value: {
      changedSymbols: [],
      changes: [{
        file: "src/lib.ts",
        hunks: [{
          beforeStartLine: 1,
          before: ["return load();"],
          afterStartLine: 5,
          after: ["return import(`./plugins/load`);"],
          container: { name: "run", kind: "method" },
        }],
      }],
    },
  },
} as unknown as ProjectFacts;

describe("engine change context for AST extraction", () => {
  it("injects changedLines and hunks into extract (3rd arg)", async () => {
    let seen: unknown;
    const exec = await executeStagedAnalysis(
      {
        text: ({ files }) => files,
        ast: {
          pattern: "(call_expression) @call",
          extract: (matches, _file, change) => {
            seen = change;
            // 脚本按变更行聚焦：只保留变更行命中的 match
            return matches
              .filter((match) => change?.changedLines?.has(match.startLine ?? -1))
              .map((match) => ({ line: match.startLine }));
          },
        },
      },
      ["src/lib.ts"],
      parser as never,
      undefined,
      factsWithChangeSurface,
    );

    const change = seen as { changedLines?: Set<number>; hunks?: readonly { container?: unknown }[] };
    expect(change?.changedLines?.has(5)).toBe(true);
    expect(change?.changedLines?.has(6)).toBe(false);
    expect(change?.hunks?.[0]?.container).toEqual({ name: "run", kind: "method" });
    // 行 5 在变更内、行 12 不在——records 只留变更行
    expect(exec.stages?.records).toEqual([{ line: 5, _file: "src/lib.ts" }]);
  });

  it("passes empty context when change surface is unavailable", async () => {
    let seen: unknown;
    await executeStagedAnalysis(
      {
        ast: {
          pattern: "(call_expression) @call",
          extract: (matches, _file, change) => {
            seen = change;
            return matches.map((match) => ({ line: match.startLine }));
          },
        },
      },
      ["src/lib.ts"],
      parser as never,
      undefined,
      emptyProjectFacts(),
    );

    const change = seen as { changedLines?: unknown; hunks?: unknown };
    expect(change?.changedLines).toBeUndefined();
    expect(change?.hunks).toBeUndefined();
  });

  it("passes allFiles to the text stage (supplementary full candidate list)", async () => {
    let seen: { files?: readonly string[]; allFiles?: readonly string[] } | undefined;
    await executeStagedAnalysis(
      {
        text: ({ files, allFiles }) => {
          seen = { files, allFiles };
          return files;
        },
      },
      ["src/a.ts"],
      parser as never,
      undefined,
      emptyProjectFacts(),
      ["src/a.ts", "src/b.ts"],
    );

    // files 保持默认候选；allFiles 是补充全量列表（消费者模式等显式取用）
    expect(seen?.files).toEqual(["src/a.ts"]);
    expect(seen?.allFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("normalizes absolute paths to repository-relative at the engine boundary", async () => {
    const abs = (p: string) => join(process.cwd(), p);
    let seenText: { files?: readonly string[]; allFiles?: readonly string[] } | undefined;
    const exec = await executeStagedAnalysis(
      {
        text: ({ files, allFiles }) => {
          seenText = { files, allFiles };
          return allFiles ?? files;
        },
        ast: {
          pattern: "(call_expression) @call",
          extract: (matches, _file) => matches.map((match) => ({ line: match.startLine })),
        },
      },
      [abs("src/a.ts")],
      parser as never,
      undefined,
      emptyProjectFacts(),
      [abs("src/a.ts"), abs("src/b.ts")],
    );

    // 多人协作 checkout 位置不确定：引擎只向脚本暴露仓库相对路径
    expect(seenText?.files).toEqual(["src/a.ts"]);
    expect(seenText?.allFiles).toEqual(["src/a.ts", "src/b.ts"]);
    // records._file 同样归一化
    for (const record of exec.stages?.records ?? []) {
      expect(record._file.startsWith("src/")).toBe(true);
      expect(record._file.startsWith(process.cwd())).toBe(false);
    }
  });
});
