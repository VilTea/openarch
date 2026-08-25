import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const gitInit = (cwd: string): void => {
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd });
  execFileSync("git", ["config", "user.email", "openarch@example.test"], { cwd });
  execFileSync("git", ["config", "user.name", "OpenArch Test"], { cwd });
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

  it("resolves project-relative changed paths for a shared scope", () => {
    const project = tempDir();
    const docs = tempDir();
    mkdirSync(join(project, ".openarch", "docs-repo"), { recursive: true });
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(project, ".openarch", ".docs-repo-config.json"), JSON.stringify({
      version: "5.2", target: docs, type: "local", cloned_at: "2026-07-16T00:00:00.000Z", auto_sync: false,
    }));
    expect("error" in configureSharedDocumentStore(project, "projects/service-a", "repository:service-a")).toBe(false);
    const scope = join(docs, "projects", "service-a");
    writeFileSync(join(scope, "first.md"), "# Parser Boundary\n\nUse one parser authority for every language.");
    expect(docsCommand(["check"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);
    writeFileSync(join(scope, "first.md"), "# Parser Boundary\n\nUse one parser authority for every supported language.");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(docsCommand(["check", "--changed", "projects/service-a/first.md"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);
    expect(output.mock.calls.flat().join("\n")).toContain("updated: 1");
  });

  it("fails with WARN semantics when staged documents still contain required placeholders", () => {
    const project = tempDir();
    gitInit(project);
    initializeProjectDocumentStore(project);
    const template = join(project, "docs", "openarch", "wisdom", "patterns", "open.md");
    writeFileSync(template, "# Open question\n来源: openarch docs record\n\n## 背景\n<!-- 必填：什么改动触发了这条记录？ -->\n");
    execFileSync("git", ["add", "docs/openarch/wisdom/patterns/open.md"], { cwd: project });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(docsCommand(["check", "--staged"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(1);
    expect(output.mock.calls.flat().join("\n")).toContain("[UNFILLED] wisdom/patterns/open.md");
  });

  it("runs similarity verification separately with --similar", () => {
    const project = tempDir();
    gitInit(project);
    initializeProjectDocumentStore(project);
    const first = join(project, "docs", "openarch", "wisdom", "patterns", "first.md");
    const second = join(project, "docs", "openarch", "wisdom", "patterns", "second.md");
    writeFileSync(first, "# Parser boundary\n\nUse one parser authority for every language.");
    writeFileSync(second, "# Parser boundary\n\nUse one parser authority for every supported language.");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(docsCommand(["check", "--similar"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);
    const rendered = output.mock.calls.flat().join("\n");
    expect(rendered).toContain("Candidates: 1");
  });

  it("keeps unfilled template verification separate from similarity candidates", () => {
    const project = tempDir();
    gitInit(project);
    initializeProjectDocumentStore(project);
    const template = join(project, "docs", "openarch", "wisdom", "patterns", "open.md");
    writeFileSync(template, "# Open question\n来源: openarch docs record\n\n## 背景\n<!-- 必填：什么改动触发了这条记录？ -->\n");
    execFileSync("git", ["add", "docs/openarch/wisdom/patterns/open.md"], { cwd: project });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(docsCommand(["check", "--staged", "--unfilled"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(1);
    const rendered = output.mock.calls.flat().join("\n");
    expect(rendered).toContain("[UNFILLED] wisdom/patterns/open.md");
    expect(rendered).not.toContain("Candidates:");
  });

  it("prints the docs-check-json-v1 machine contract", () => {
    const project = tempDir();
    initializeProjectDocumentStore(project);
    writeFileSync(join(project, "docs", "openarch", "wisdom", "patterns", "one.md"), "# One\n");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(docsCommand(["check", "--json"], { cwd: project, rawArgv: [], locale: "en" })).toBe(0);
    const json = JSON.parse(String(output.mock.calls[0][0]));
    expect(json.schema).toBe("docs-check-json-v1");
    expect(json.stores[0].scopeId).toBe("repository-local");
    expect(json.stores[0].indexed).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(json.stores[0].unfilled)).toBe(true);
  });

  it("defers similarity checking until the generated document is filled", async () => {
    const project = tempDir();
    initializeProjectDocumentStore(project);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await recordCommand(["scope-registry"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);

    const rendered = output.mock.calls.flat().join("\n");
    expect(rendered).toContain("填写完成后运行: openarch docs check --changed");
    expect(rendered).toContain("提交前运行: openarch docs check --changed");
    expect(rendered).not.toContain("文档相似检查:");
  });

  it("generates a localized record template from the command locale", async () => {
    const project = tempDir();
    initializeProjectDocumentStore(project);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await recordCommand(["localized-record"], { cwd: project, rawArgv: [], locale: "en" })).toBe(0);
    expect(output.mock.calls.flat().join("\n")).toContain("After filling it in");

    const patterns = join(project, "docs", "openarch", "wisdom", "patterns");
    const generated = readdirSync(patterns).find((file) => file.endsWith("-localized-record.md"));
    expect(generated).toBeDefined();
    const content = readFileSync(join(patterns, generated!), "utf8");
    expect(content).toContain("Source: openarch docs record");
    expect(content).toContain("<!-- REQUIRED:");
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

describe("docs decide and status", () => {
  it("records a scope-relative disposition and closes the candidate", () => {
    const project = tempDir();
    initializeProjectDocumentStore(project);
    const first = join(project, "docs", "openarch", "wisdom", "patterns", "first.md");
    const second = join(project, "docs", "openarch", "wisdom", "patterns", "second.md");
    writeFileSync(first, "# Parser boundary\n\nUse one parser authority for every language.");
    writeFileSync(second, "# Parser boundary\n\nUse one parser authority for every supported language.");
    docsCommand(["check"], { cwd: project, rawArgv: [], locale: "zh" });

    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(docsCommand(["decide", "--left", "wisdom/patterns/first.md", "--right", "wisdom/patterns/second.md", "--decision", "kept-separate"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);
    expect(output.mock.calls.flat().join("\n")).toContain("已记录处置");

    output.mockClear();
    expect(docsCommand(["status"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);
    const status = output.mock.calls.flat().join("\n");
    expect(status).toContain("未处置相似候选: 0");
    expect(JSON.parse(readFileSync(join(project, "docs", "openarch", "document-relations.v1.json"), "utf8")).dispositions).toHaveLength(1);
  });

  it("rejects malformed disposition inputs", () => {
    const project = tempDir();
    initializeProjectDocumentStore(project);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(docsCommand(["decide", "--left", "a.md", "--right", "a.md", "--decision", "merged"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(3);
    expect(error).toHaveBeenCalled();
  });
});
