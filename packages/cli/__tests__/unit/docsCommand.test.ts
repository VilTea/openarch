import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureSharedDocumentStore, initializeProjectDocumentStore } from "@openarch/core";
import { docsCommand } from "../../src/commands/docs";
import { recordCommand } from "../../src/commands/record";

const temporaryRoots: string[] = [];
const tempDir = () => {
  const path = join(tmpdir(), `openarch-docs-command-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  temporaryRoots.push(path);
  return path;
};

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("docs check", () => {
  it("resolves registered shared scopes when invoked by the docs Git hook", () => {
    const project = tempDir();
    const docs = tempDir();
    mkdirSync(join(project, ".openarch", "docs-repo"), { recursive: true });
    mkdirSync(docs, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: docs });
    writeFileSync(join(project, ".openarch", ".docs-repo-config.json"), JSON.stringify({
      version: "5.2", target: docs, type: "local", cloned_at: "2026-07-16T00:00:00.000Z", auto_sync: false,
    }));
    expect("error" in configureSharedDocumentStore(project, "projects/service-a", "repository:service-a")).toBe(false);

    const scope = join(docs, "projects", "service-a");
    writeFileSync(join(scope, "first.md"), "# Parser Boundary\n\nUse one parser authority for every language.");
    writeFileSync(join(scope, "second.md"), "# Parser Boundary\n\nUse one parser authority for every supported language.");
    execFileSync("git", ["add", "projects/service-a/first.md", "projects/service-a/second.md"], { cwd: docs });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(docsCommand(["check", "--staged"], { cwd: docs, rawArgv: [], locale: "zh" })).toBe(0);

    expect(output.mock.calls.flat().join("\n")).toContain("scope: repository:service-a");
    expect(output.mock.calls.flat().join("\n")).toContain("Candidates: 1");
  });

  it("defers similarity checking until the generated document is filled", async () => {
    const project = tempDir();
    initializeProjectDocumentStore(project);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await recordCommand(["scope-registry"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);

    const rendered = output.mock.calls.flat().join("\n");
    expect(rendered).toContain("填写完成后运行: openarch docs check --changed");
    expect(rendered).not.toContain("文档相似检查:");
  });

  it("creates an explicit category in its final document location", async () => {
    const project = tempDir();
    initializeProjectDocumentStore(project);

    expect(await recordCommand(["--category", "anti_patterns", "placeholder false positives"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);

    const antiPatterns = join(project, "docs", "openarch", "wisdom", "anti_patterns");
    const patterns = join(project, "docs", "openarch", "wisdom", "patterns");
    expect(readdirSync(antiPatterns).some((file) => file.endsWith("-placeholder-false-positives.md"))).toBe(true);
    expect(existsSync(patterns) && readdirSync(patterns).some((file) => file.endsWith("-placeholder-false-positives.md"))).toBe(false);
  });
});
