import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectGitChangeSet, collectGitCommitHistory, collectGitRevisionChangeSet } from "../../src/application/changeSet";
import { analyzeChangeSetSemantics } from "../../src/application/semanticDiff";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { Effect } from "effect";
import { withGitRepo } from "../support/tsProject";

const git = (cwd: string, args: readonly string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

describe("collectGitChangeSet", () => {
  it("keeps nested OpenArch projects relative to their own Git scope", () => {
    const root = join(tmpdir(), `openarch-nested-change-set-${Date.now()}`);
    const cwd = join(root, "services", "worker");
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(cwd, ".openarch"), { recursive: true });
    writeFileSync(join(cwd, ".openarch", "config.yml"), 'languages: ["typescript"]\n');
    writeFileSync(join(root, "root.ts"), "export const root = true;\n");
    writeFileSync(join(cwd, "src", "worker.ts"), "export const worker = 'before';\n");
    git(root, ["init"]);
    git(root, ["config", "user.email", "openarch@example.test"]);
    git(root, ["config", "user.name", "OpenArch Test"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "baseline"]);
    writeFileSync(join(root, "root.ts"), "export const root = false;\n");
    writeFileSync(join(cwd, "src", "worker.ts"), "export const worker = 'after';\n");

    expect(collectGitChangeSet(cwd)).toEqual(expect.objectContaining({
      availability: "available",
      files: [expect.objectContaining({
        path: "src/worker.ts",
        beforeText: "export const worker = 'before';\n",
        afterText: "export const worker = 'after';\n",
      })],
    }));
    rmSync(root, { recursive: true, force: true });
  });

  it("returns bounded production-source facts for tracked and untracked edits", () => {
    withGitRepo([
      { path: "src/existing.ts", content: "export const before = true;\n" },
      { path: "src/second.ts", content: "export const secondBefore = true;\n" },
    ], (cwd) => {
      writeFileSync(join(cwd, "src", "existing.ts"), "export const after = true;\n");
      writeFileSync(join(cwd, "src", "second.ts"), "export const secondAfter = true;\n");
      writeFileSync(join(cwd, "src", "added.ts"), "export const added = true;\n");
      const changeSet = collectGitChangeSet(cwd);

      expect(changeSet.availability).toBe("available");
      expect(changeSet.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "src/existing.ts", kind: "modified", beforeText: "export const before = true;\n", afterText: "export const after = true;\n" }),
        expect.objectContaining({ path: "src/second.ts", kind: "modified", beforeText: "export const secondBefore = true;\n", afterText: "export const secondAfter = true;\n" }),
        expect.objectContaining({ path: "src/added.ts", kind: "added", afterText: "export const added = true;\n" }),
      ]));
    });
  });

  it("does not represent a non-Git directory as a clean change set", () => {
    const cwd = join(tmpdir(), `openarch-no-git-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    const changeSet = collectGitChangeSet(cwd);
    expect(changeSet.availability).toBe("unavailable");
    expect(changeSet.files).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("includes tests as change evidence without admitting configured auxiliary inputs", () => {
    withGitRepo([
      { path: "src/api.ts", content: "export const version = 1;\n" },
      { path: "__tests__/api.test.ts", content: "export const version = 1;\n" },
      { path: "fixtures/input.ts", content: "export const version = 1;\n" },
    ], (cwd) => {
      writeFileSync(join(cwd, "src", "api.ts"), "export const version = 2;\n");
      writeFileSync(join(cwd, "__tests__", "api.test.ts"), "export const version = 2;\n");
      writeFileSync(join(cwd, "fixtures", "input.ts"), "export const version = 2;\n");

      const changeSet = collectGitChangeSet(cwd, [], { population: "change-evidence" });
      expect(changeSet.files.map((file) => file.path).sort()).toEqual(["__tests__/api.test.ts", "src/api.ts"]);
    }, { configYaml: 'languages: ["typescript"]\nfile_kinds:\n  - pattern: "fixtures/**"\n    kind: "auxiliary"\n' });
  });

  it("reads index blobs for staged evidence when the worktree has later edits", () => {
    withGitRepo([
      { path: "src/api.ts", content: "export const version = 'before';\n" },
    ], (cwd) => {
      writeFileSync(join(cwd, "src", "api.ts"), "export const version = 'staged';\n");
      git(cwd, ["add", "src/api.ts"]);
      writeFileSync(join(cwd, "src", "api.ts"), "export const version = 'unstaged';\n");

      expect(collectGitChangeSet(cwd, [], { source: "staged" })).toEqual(expect.objectContaining({
        availability: "available",
        files: [expect.objectContaining({
          path: "src/api.ts",
          beforeText: "export const version = 'before';\n",
          afterText: "export const version = 'staged';\n",
        })],
      }));
    });
  });

  it("keeps oversized historical blobs partial without reading them as semantic source", () => {
    withGitRepo([
      { path: "src/large.ts", content: `export const payload = "${"x".repeat(512 * 1024)}";\n` },
    ], (cwd) => {
      writeFileSync(join(cwd, "src", "large.ts"), "export const payload = 'small';\n");

      const changeSet = collectGitChangeSet(cwd);

      expect(changeSet).toMatchObject({ availability: "partial", reason: expect.stringContaining("1 file") });
      expect(changeSet.files).toEqual([expect.objectContaining({ path: "src/large.ts", afterText: "export const payload = 'small';\n", beforeText: undefined })]);
    });
  });

  it("derives declaration-level change profiles from the Git before/after source", async () => {
    withGitRepo([
      { path: "src/api.ts", content: "export interface Api { value: string; }\nexport function run() { return 'old'; }\n" },
    ], (cwd) => {
      writeFileSync(join(cwd, "src", "api.ts"), "import { next } from './next';\nexport interface Api { value: number; }\nexport function run() { return next(); }\n");

      return Effect.runPromise(
        analyzeChangeSetSemantics(cwd, collectGitChangeSet(cwd)).pipe(Effect.provide(TreeSitterParserLive)),
      ).then((report) => {
        expect(report).toEqual(expect.objectContaining({
          availability: "available",
          profiles: [expect.objectContaining({
            file: "src/api.ts",
            changes: expect.arrayContaining([
              { anchor: "Api.value", kind: "field_add_remove" },
              { anchor: "run", kind: "function_body" },
              { anchor: "import:./next", kind: "dependency_add" },
            ]),
          })],
        }));
      });
    });
  });

  it("classifies non-production top-level test changes without claiming public contracts", async () => {
    const report = await Effect.runPromise(analyzeChangeSetSemantics(".", {
      availability: "available",
      files: [{ path: "src/api.test.ts", kind: "modified", beforeText: "describe('api', () => {});", afterText: "describe('api', () => { it('works', () => {}); });" }],
    }).pipe(Effect.provide(TreeSitterParserLive)));
    expect(report).toEqual(expect.objectContaining({
      availability: "available",
      profiles: [expect.objectContaining({
        file: "src/api.test.ts",
        changes: [{ anchor: "file:top-level", kind: "function_body" }],
        beforeState: "git",
      })],
    }));
  });

  it("groups historical source changes by real Git commit instead of a caller-selected diff batch", () => {
    withGitRepo([
      { path: "src/catalog.ts", content: "export const catalog = true;\n" },
    ], (cwd) => {
      writeFileSync(join(cwd, "src", "provider.ts"), "export const provider = true;\n");
      writeFileSync(join(cwd, "src", "catalog.ts"), "export const catalog = false;\n");
      git(cwd, ["add", "."]);
      git(cwd, ["commit", "-m", "register provider"]);

      const history = collectGitCommitHistory(cwd);
      expect(history).toMatchObject({ availability: "available" });
      expect(history.changeSets[0]?.files).toEqual(["src/catalog.ts", "src/provider.ts"]);
      expect(history.changeSets[0]?.changes).toEqual([
        { path: "src/catalog.ts", kind: "modified" },
        { path: "src/provider.ts", kind: "added" },
      ]);
    });
  });

  it("reads a committed revision through the bounded before/after change-set contract", () => {
    withGitRepo([
      { path: "src/catalog.ts", content: "export const catalog = [] as string[];\n" },
    ], (cwd) => {
      writeFileSync(join(cwd, "src", "member.ts"), "export const member = true;\n");
      writeFileSync(join(cwd, "src", "catalog.ts"), 'import { member } from "./member";\nexport const catalog = [member];\n');
      git(cwd, ["add", "."]);
      git(cwd, ["commit", "-m", "register member"]);
      const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();

      expect(collectGitRevisionChangeSet(cwd, revision)).toEqual(expect.objectContaining({
        availability: "available",
        files: expect.arrayContaining([
          expect.objectContaining({ path: "src/catalog.ts", kind: "modified", beforeText: "export const catalog = [] as string[];\n", afterText: expect.stringContaining('import { member }') }),
          expect.objectContaining({ path: "src/member.ts", kind: "added", afterText: "export const member = true;\n" }),
        ]),
      }));
    });
  });

  it("preserves both paths of a Git-detected rename as bounded change evidence", () => {
    withGitRepo([
      { path: "src/before.ts", content: "export function moved() {}\n" },
    ], (cwd) => {
      git(cwd, ["mv", "src/before.ts", "src/after.ts"]);
      git(cwd, ["commit", "-am", "move"]);
      const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();

      expect(collectGitRevisionChangeSet(cwd, revision).files).toEqual([
        expect.objectContaining({ path: "src/after.ts", beforePath: "src/before.ts", kind: "modified" }),
      ]);
    });
  });
});
