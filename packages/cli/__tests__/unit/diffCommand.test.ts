import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import * as runtime from "../../src/runtime";
import { diffCommand } from "../../src/commands/diff";
import { collectGitChangeSet } from "@openarch/core";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("@openarch/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openarch/core")>();
  return {
    ...actual,
    LAMBDA_AST: { function_body: 10 },
    diff: vi.fn(() => ({ pipe: () => ({}) })),
    collectGitChangeSet: vi.fn(),
    analyzeChangeSetSemantics: vi.fn(() => ({ pipe: () => ({}) })),
  };
});

vi.mock("effect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect")>();
  return {
    ...actual,
    Effect: {
      ...actual.Effect,
      runPromise: vi.fn(async () => ({
        _tag: "Right",
      right: {
        summary: {
          iPush: 0,
          dMR: 0,
          deltas: [],
          historyEntryId: "history-id",
          evidenceState: "available",
        },
        evidence: { mrDetail: [], crl: new Map(), impactPlan: [] },
      },
      })),
    },
  };
});

describe("diffCommand input filtering", () => {
  const context = { cwd: "/repo", rawArgv: [], locale: "zh" as const };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    vi.spyOn(runtime, "readImplicitDeps").mockResolvedValue([]);
    vi.mocked(collectGitChangeSet).mockReturnValue({ availability: "available", files: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects manual diff files outside configured project languages", async () => {
    vi.spyOn(runtime, "isAnalyzableSourceFile").mockReturnValue(false);

    const exitCode = await diffCommand(["--change-type", "function_body", "services/coordination/main.go"], context);

    expect(exitCode).toBe(3);
    expect(error).toHaveBeenCalledWith("没有匹配当前项目 languages 配置的可分析文件。");
  });

  it("keeps analyzable manual diff files", async () => {
    vi.spyOn(runtime, "isAnalyzableSourceFile").mockImplementation((path) => path.endsWith(".ts"));

    const exitCode = await diffCommand(["--change-type", "function_body", "packages/core/src/application/diff.ts", "services/coordination/main.go"], context);

    expect(exitCode).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(vi.mocked((await import("@openarch/core")).diff)).toHaveBeenCalledWith(expect.objectContaining({
      persistence: "pending",
      revisionKey: expect.any(String),
    }));
  });

  it("uses Git/AST profiles when no manual change type is supplied", async () => {
    vi.spyOn(runtime, "isAnalyzableSourceFile").mockReturnValue(true);
    vi.mocked((await import("effect")).Effect.runPromise)
      .mockResolvedValueOnce({ _tag: "Right", right: { availability: "available", profiles: [{ file: "src/api.ts", changes: [{ anchor: "Api", kind: "interface_add_remove" }] }] } } as never)
      .mockResolvedValueOnce({ _tag: "Right", right: {
        summary: { iPush: 1, dMR: 0, deltas: [], historyEntryId: "history-id", evidenceState: "sealed" },
        evidence: { mrDetail: [], crl: new Map(), impactPlan: [] },
      } } as never);

    const exitCode = await diffCommand(["src/api.ts"], context);

    expect(exitCode).toBe(0);
  });

  it("does not pass an unchanged requested path past automatic semantic evidence", async () => {
    vi.spyOn(runtime, "isAnalyzableSourceFile").mockReturnValue(true);
    vi.mocked((await import("effect")).Effect.runPromise)
      .mockResolvedValueOnce({ _tag: "Right", right: { availability: "available", profiles: [{ file: "src/changed.ts", changes: [{ anchor: "run", kind: "function_body" }] }] } } as never)
      .mockResolvedValueOnce({ _tag: "Right", right: {
        summary: { iPush: 1, dMR: 0, deltas: [], historyEntryId: "history-id", evidenceState: "sealed" },
        evidence: { mrDetail: [], crl: new Map(), impactPlan: [] },
      } } as never);

    await diffCommand(["src/changed.ts", "src/unchanged.ts"], context);

    expect(vi.mocked((await import("@openarch/core")).diff)).toHaveBeenLastCalledWith(expect.objectContaining({ changedFiles: ["src/changed.ts"] }));
  });

  it("uses the same staged source set as pre-commit evidence sealing", async () => {
    vi.mocked(execFileSync).mockImplementation((command, args) =>
      command === "git" && Array.isArray(args) && args.includes("diff")
        ? "src/staged.ts\n" as never
        : "" as never,
    );
    vi.spyOn(runtime, "isAnalyzableSourceFile").mockReturnValue(true);
    vi.mocked((await import("effect")).Effect.runPromise)
      .mockResolvedValueOnce({ _tag: "Right", right: { availability: "available", profiles: [{ file: "src/staged.ts", changes: [{ anchor: "run", kind: "function_body" }] }] } } as never)
      .mockResolvedValueOnce({ _tag: "Right", right: {
        summary: { iPush: 1, dMR: 0, deltas: [], historyEntryId: "history-id", evidenceState: "sealed" },
        evidence: { mrDetail: [], crl: new Map(), impactPlan: [] },
      } } as never);

    expect(await diffCommand(["--staged"], context)).toBe(0);

    expect(vi.mocked((await import("@openarch/core")).diff)).toHaveBeenLastCalledWith(expect.objectContaining({ changedFiles: ["src/staged.ts"] }));
  });

  it("rejects ambiguous staged analysis and evidence sealing", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await diffCommand(["--staged", "--pre-commit"], context)).toBe(3);
    expect(stderr).toHaveBeenCalledWith("--staged 与 --pre-commit 不能同时使用");
  });

  it("does not present worktree LSP facts as staged Git-index evidence", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await diffCommand(["--staged", "--semantic"], context)).toBe(3);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("--semantic 只能分析工作树"));
  });

  it("rejects an unclassified staged diff without matching semantic evidence", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(execSync).mockImplementation((command) => command.includes(".openarch/history") ? "" as never : "packages/cli/src/runtime.ts\n" as never);
    vi.mocked(execFileSync).mockImplementation((command, args) =>
      command === "git" && Array.isArray(args) && args.includes("diff")
        ? "packages/cli/src/runtime.ts\n" as never
        : "" as never,
    );
    vi.spyOn(runtime, "isAnalyzableSourceFile").mockReturnValue(true);

    const exitCode = await diffCommand(["--pre-commit"], context);

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("缺少已暂存语义证据"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("openarch check --staged --report"));
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("--change-type <actual-kind>"));
  });

  it("compacts sealed history only after matching staged evidence is finalized", async () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(execFileSync).mockImplementation((command, args) =>
      command === "git" && Array.isArray(args) && args.includes("diff")
        ? "packages/cli/src/runtime.ts\n" as never
        : "" as never,
    );
    vi.spyOn(runtime, "isAnalyzableSourceFile").mockReturnValue(true);
    vi.mocked((await import("effect")).Effect.runPromise)
      .mockResolvedValueOnce({ _tag: "Right", right: { status: "finalized", compaction: { compactedEntries: 9, retainedEntries: 4 } } } as never);

    expect(await diffCommand(["--pre-commit"], context)).toBe(0);
    expect(vi.mocked((await import("effect")).Effect.runPromise)).toHaveBeenCalledTimes(1);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("已压缩 9 条 sealed history"));
  });
});
