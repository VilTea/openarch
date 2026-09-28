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

/** A filled record that keeps the generator's guidance comments; the section
 *  named by `emptySection` is left genuinely empty. */
const recordDocument = (emptySection?: "背景" | "分析" | "应对" | "教训"): string => [
  "# Open question",
  "来源: openarch docs record",
  "",
  "## 背景",
  "<!-- 必填：什么改动触发了这条记录？涉及哪些文件？ -->",
  emptySection === "背景" ? "" : "模型替换了权威解析器。",
  "",
  "## 分析",
  "<!-- 必填：为什么触发规则？CRL 趋势如何？ -->",
  emptySection === "分析" ? "" : "手写 parser 分支天然集中。",
  "",
  "## 应对",
  "<!-- 必填：做了什么决定？ -->",
  emptySection === "应对" ? "" : "接受 WARN，Phase 2 换完整 CEL 实现。",
  "",
  "## 教训",
  "<!-- 必填：下次遇到类似情况怎么处理？ -->",
  emptySection === "教训" ? "" : "先确认分支集中位置，再校准阈值。",
  "",
].join("\n");

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

  it("fails when a staged record template still has an empty required section", () => {
    const project = tempDir();
    gitInit(project);
    initializeProjectDocumentStore(project);
    const template = join(project, "docs", "openarch", "wisdom", "patterns", "open.md");
    writeFileSync(template, "# Open question\n来源: openarch docs record\n\n## 背景\n<!-- 必填：什么改动触发了这条记录？ -->\n\n");
    execFileSync("git", ["add", "docs/openarch/wisdom/patterns/open.md"], { cwd: project });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(docsCommand(["check", "--staged"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(1);
    expect(output.mock.calls.flat().join("\n")).toContain("[UNFILLED] wisdom/patterns/open.md");
  });

  it("accepts a fully filled record that still carries the guidance comments", () => {
    const project = tempDir();
    gitInit(project);
    initializeProjectDocumentStore(project);
    const relative = "docs/openarch/wisdom/patterns/filled.md";
    writeFileSync(join(project, relative), recordDocument());
    execFileSync("git", ["add", relative], { cwd: project });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(docsCommand(["check", "--staged"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);
    expect(output.mock.calls.flat().join("\n")).not.toContain("[UNFILLED]");

    output.mockClear();
    expect(docsCommand(["check", "--changed", relative], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);
    expect(output.mock.calls.flat().join("\n")).not.toContain("[UNFILLED]");

    output.mockClear();
    expect(docsCommand(["status"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);
    expect(output.mock.calls.flat().join("\n")).toContain("未填写模板: 0");
  });

  it("fails when a record leaves one required section empty while the others are filled", () => {
    const project = tempDir();
    gitInit(project);
    initializeProjectDocumentStore(project);
    const relative = "docs/openarch/wisdom/patterns/partial.md";
    writeFileSync(join(project, relative), recordDocument("教训"));
    execFileSync("git", ["add", relative], { cwd: project });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(docsCommand(["check", "--staged"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(1);
    expect(output.mock.calls.flat().join("\n")).toContain("[UNFILLED] wisdom/patterns/partial.md");
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
    writeFileSync(template, "# Open question\n来源: openarch docs record\n\n## 背景\n<!-- 必填：什么改动触发了这条记录？ -->\n\n");
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

  it("fails on a freshly generated record template that has nothing filled in", async () => {
    const project = tempDir();
    gitInit(project);
    initializeProjectDocumentStore(project);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await recordCommand(["empty-record"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);
    const patterns = join(project, "docs", "openarch", "wisdom", "patterns");
    const generated = readdirSync(patterns).find((file) => file.endsWith("-empty-record.md"));
    expect(generated).toBeDefined();
    execFileSync("git", ["add", `docs/openarch/wisdom/patterns/${generated}`], { cwd: project });
    output.mockClear();

    expect(docsCommand(["check", "--staged"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(1);
    expect(output.mock.calls.flat().join("\n")).toContain(`[UNFILLED] wisdom/patterns/${generated}`);
  });

  it("generates a comment-free template with --no-comments and accepts it once filled", async () => {
    const project = tempDir();
    initializeProjectDocumentStore(project);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await recordCommand(["--no-comments", "clean-record"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);
    const patterns = join(project, "docs", "openarch", "wisdom", "patterns");
    const generated = readdirSync(patterns).find((file) => file.endsWith("-clean-record.md"));
    expect(generated).toBeDefined();
    const relative = `docs/openarch/wisdom/patterns/${generated}`;
    const generatedPath = join(patterns, generated!);
    const content = readFileSync(generatedPath, "utf8");
    expect(content).not.toContain("<!--");
    expect(content).toContain("来源: openarch docs record");
    expect(content).toContain("## 背景");

    output.mockClear();
    expect(docsCommand(["check", "--changed", relative], { cwd: project, rawArgv: [], locale: "zh" })).toBe(1);
    expect(output.mock.calls.flat().join("\n")).toContain(`[UNFILLED] wisdom/patterns/${generated}`);

    writeFileSync(generatedPath, content.replace(/^(## .+)$/gm, "$1\n已填写结论。"));
    output.mockClear();
    expect(docsCommand(["check", "--changed", relative], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);
    expect(output.mock.calls.flat().join("\n")).not.toContain("[UNFILLED]");
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

// 审计回归 A：`d7c3cea6` 之前生成器写 `来源: openarch record`，未填写判据诞生时只认
// `openarch docs record`，历史记录因此整批落在判定人口之外（实测共享库 26 篇中 24 篇）。
describe("docs check（legacy provenance 与标题变体）", () => {
  /** 手工构造旧格式模板（`d7c3cea6` 之前的生成器输出）：来源行无 `docs`，
   *  每个必填小节标题下带引导注释，正文由 `body` 决定（空 = 未填写）。 */
  const legacyRecord = (body: string): string => [
    "# Open question", "来源: openarch record", "",
    "## 背景", "<!-- 必填：什么改动触发了这条记录？ -->", body, "",
    "## 分析", "<!-- 必填：为什么触发规则？ -->", body, "",
    "## 应对", "<!-- 必填：做了什么决定？ -->", body, "",
    "## 教训", "<!-- 必填：下次遇到类似情况怎么处理？ -->", body, "",
  ].join("\n");

  it("flags an unfilled legacy-format record instead of letting the whole population escape", () => {
    const project = tempDir();
    gitInit(project);
    initializeProjectDocumentStore(project);
    const generated = join(project, "docs", "openarch", "wisdom", "patterns", "legacy-empty.md");
    const stagedPath = "docs/openarch/wisdom/patterns/legacy-empty.md";

    // 旧格式 + 全部必填小节空正文 ⇒ 必须判为未填写。
    writeFileSync(generated, legacyRecord(""));
    execFileSync("git", ["add", stagedPath], { cwd: project });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(docsCommand(["check", "--staged"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(1);
    expect(output.mock.calls.flat().join("\n")).toContain("[UNFILLED] wisdom/patterns/legacy-empty.md");

    // 同一份旧格式填好正文 ⇒ 不再判定。
    writeFileSync(generated, legacyRecord("已填写结论。"));
    execFileSync("git", ["add", stagedPath], { cwd: project });
    output.mockClear();
    expect(docsCommand(["check", "--staged"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);
    expect(output.mock.calls.flat().join("\n")).not.toContain("[UNFILLED]");

    // 手工来源（`openarch dogfood`）仍不在人口内：它没有必填标题。
    const dogfood = join(project, "docs", "openarch", "wisdom", "patterns", "dogfood.md");
    writeFileSync(dogfood, ["# 狗粮记录", "来源: OpenArch dogfood", "", "## 观察", "看到了什么。", "", "## 应对", "做了什么。", "", "## 边界", "哪里不适用。"].join("\n"));
    execFileSync("git", ["add", "docs/openarch/wisdom/patterns/dogfood.md"], { cwd: project });
    output.mockClear();
    expect(docsCommand(["check", "--staged"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);
    expect(output.mock.calls.flat().join("\n")).not.toContain("[UNFILLED]");

    // --unfilled 模式（hook 的紧凑清单）同样看到旧格式。
    writeFileSync(generated, legacyRecord(""));
    execFileSync("git", ["add", stagedPath], { cwd: project });
    output.mockClear();
    expect(docsCommand(["check", "--staged", "--unfilled"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(1);
    expect(output.mock.calls.flat().join("\n")).toContain("[UNFILLED] wisdom/patterns/legacy-empty.md");
  });

  it("flags a required section whose heading carries a trailing annotation", () => {
    const project = tempDir();
    gitInit(project);
    initializeProjectDocumentStore(project);
    const variant = recordDocument("教训").replace("## 教训", "## 教训（通用经验——可跨项目复用）");    const generated = join(project, "docs", "openarch", "wisdom", "patterns", "variant.md");
    writeFileSync(generated, variant);
    execFileSync("git", ["add", "docs/openarch/wisdom/patterns/variant.md"], { cwd: project });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(docsCommand(["check", "--staged"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(1);
    expect(output.mock.calls.flat().join("\n")).toContain("[UNFILLED] wisdom/patterns/variant.md");

    // 填好该变体小节 ⇒ 不再判定。
    writeFileSync(generated, variant.replace("## 教训（通用经验——可跨项目复用）", "## 教训（通用经验——可跨项目复用）\n先确认分支集中位置，再校准阈值。"));
    execFileSync("git", ["add", "docs/openarch/wisdom/patterns/variant.md"], { cwd: project });
    output.mockClear();
    expect(docsCommand(["check", "--staged"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);
    expect(output.mock.calls.flat().join("\n")).not.toContain("[UNFILLED]");
  });
});

// 审计回归 B：人口披露必须出现在报告里，且**不得**改变退出码或新增阻断。
describe("docs check（判定人口披露，report-only）", () => {
  it("discloses the population threshold without changing the exit code", () => {
    const project = tempDir();
    gitInit(project);
    initializeProjectDocumentStore(project);
    const relative = "docs/openarch/wisdom/patterns/disclosed.md";
    writeFileSync(join(project, relative), recordDocument("教训"));
    execFileSync("git", ["add", relative], { cwd: project });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // 披露存在，但判定结论与退出码不变（仍因空小节 exit 1）。
    expect(docsCommand(["check", "--staged"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(1);
    const rendered = output.mock.calls.flat().join("\n");
    expect(rendered).toContain("未填写判定人口");
    expect(rendered).toContain("不影响退出码");
    expect(rendered).toContain("[UNFILLED] wisdom/patterns/disclosed.md");

    // 填好后 exit 0：披露本身不是失败条件。
    writeFileSync(join(project, relative), recordDocument());
    execFileSync("git", ["add", relative], { cwd: project });
    output.mockClear();
    expect(docsCommand(["check", "--staged"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);
    expect(output.mock.calls.flat().join("\n")).toContain("未填写判定人口");
  });

  it("keeps --unfilled output (hook contract) and --json untouched", () => {
    const project = tempDir();
    initializeProjectDocumentStore(project);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(docsCommand(["check", "--unfilled"], { cwd: project, rawArgv: [], locale: "zh" })).toBe(0);
    expect(output.mock.calls.flat().join("\n")).not.toContain("未填写判定人口");

    output.mockClear();
    expect(docsCommand(["check", "--json"], { cwd: project, rawArgv: [], locale: "en" })).toBe(0);
    const json = JSON.parse(String(output.mock.calls[0][0]));
    // 形状未变：没有新增字段，machine contract 版本因此不动。
    expect(Object.keys(json.stores[0]).sort()).toEqual([
      "availability", "candidates", "indexed", "openCandidates", "resolvedDispositions", "scopeId", "scopeRoot", "unfilled", "updated",
    ]);
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
