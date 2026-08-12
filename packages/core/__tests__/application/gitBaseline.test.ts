import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTemporaryDirectory, initGit } from "../support/temporaryDirectory";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { Effect } from "effect";
import { ParserService } from "../../src/port/ParserService";
import { buildGitBeforeMetrics, gitHeadSha } from "../../src/application/gitBaseline";

const commitAll = (cwd: string, message: string): void => {
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "--quiet", "-m", message], { cwd });
};

const parserIn = () => Effect.gen(function* () {
  const parser = yield* ParserService;
  return parser;
}).pipe(Effect.provide(TreeSitterParserLive));

describe("gitBaseline (cold-start P2-2)", () => {
  it("gitHeadSha 返回 HEAD commit（非 git 仓库 undefined）", () => withTemporaryDirectory("git-baseline", (cwd) => {
    expect(gitHeadSha(cwd)).toBeUndefined();
    initGit(cwd);
    writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n");
    commitAll(cwd, "initial");
    expect(gitHeadSha(cwd)).toMatch(/^[0-9a-f]{40}$/);
  }));

  it("buildGitBeforeMetrics 从 HEAD blob 重建改动前度量", () => withTemporaryDirectory("git-baseline", async (cwd) => {
    initGit(cwd);
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;\n");
    commitAll(cwd, "initial");
    // 工作树修改（未提交）：增加 if 分支
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;\nif (a > 0) { console.log(a); }\n");
    const parser = await Effect.runPromise(parserIn());
    const metrics = await buildGitBeforeMetrics(parser, cwd, join(cwd, "src", "a.ts"));
    expect(metrics).not.toBeNull();
    // HEAD 版本无 if → 分支为 0
    expect(metrics!.weightedBranchTotal).toBe(0);
    expect(metrics!.loc).toBe(1);
  }, 15000));

  it("新增文件（HEAD 无此路径）返回 null", () => withTemporaryDirectory("git-baseline", async (cwd) => {
    initGit(cwd);
    writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n");
    commitAll(cwd, "initial");
    writeFileSync(join(cwd, "new.ts"), "export const n = 2;\n");
    const parser = await Effect.runPromise(parserIn());
    expect(await buildGitBeforeMetrics(parser, cwd, join(cwd, "new.ts"))).toBeNull();
  }, 15000));
});
