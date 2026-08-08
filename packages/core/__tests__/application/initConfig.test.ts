// packages/core/__tests__/application/initConfig.test.ts
import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { writeInitConfig } from "../../src/application/initConfig";
import { initApp } from "../../src/application/initApp";
import { readCoordinationConfig } from "../../src/application/coordinationConfig";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { withTemporaryDirectory, writeProjectMarkers, initGit } from "../support/temporaryDirectory";

describe("writeInitConfig", () => {
  it("首次执行 → 创建 config.yml", () => withTemporaryDirectory("init", async (dir) => {
    const r = await Effect.runPromise(writeInitConfig(dir));
    expect(r.configExisted).toBe(false);
    expect(existsSync(r.configPath)).toBe(true);
    const config = readFileSync(r.configPath, "utf8");
    expect(config).toContain("max_func_branch");
    expect(config).toContain("top_level_branch");
    expect(config).not.toContain("max_branch:");
    expect(config).not.toContain("cumulative_thresholds:");
    expect(config).toMatch(/presentation:\r?\n  locale: "(?:zh|en)"/);
    expect(config).toContain("governance:\n  # tracked: 团队可复核治理证据；local: 仅本机治理状态。\n  persistence: tracked");
    expect(readFileSync(join(dir, ".openarch", ".gitignore"), "utf8")).toContain("pending/");
    expect(readFileSync(join(dir, ".openarch", ".gitignore"), "utf8")).toContain("scan-status.json");
    expect(readFileSync(join(dir, ".openarch", ".gitignore"), "utf8")).toContain(".*.lock");
  }));

  it("二次执行 → 幂等，config 不覆盖", () => withTemporaryDirectory("init", async (dir) => {
    await Effect.runPromise(writeInitConfig(dir));
    const r = await Effect.runPromise(writeInitConfig(dir));
    expect(r.configExisted).toBe(true);
  }));

  it("多次执行 → 依然幂等", () => withTemporaryDirectory("init", async (dir) => {
    const first = await Effect.runPromise(writeInitConfig(dir));
    const ignorePath = join(dir, ".openarch", ".gitignore");
    const initialIgnore = readFileSync(ignorePath, "utf8");
    await Effect.runPromise(writeInitConfig(dir));
    const r = await Effect.runPromise(writeInitConfig(dir));
    expect(r.configExisted).toBe(true);
    expect(first.excludeUpdated).toBe(true);
    expect(r.excludeUpdated).toBe(false);
    expect(readFileSync(ignorePath, "utf8")).toBe(initialIgnore);
  }));

  it("检测到 go.mod 时，默认写 go 语言配置", () => withTemporaryDirectory("init", async (dir) => {
    writeProjectMarkers(dir, { "go.mod": "module example.com/demo\n\ngo 1.26.0\n" });

    const result = await Effect.runPromise(writeInitConfig(dir));
    const config = readFileSync(result.configPath, "utf8");

    expect(config).toContain('languages: ["go"]');
  }));

  it("检测到 pyproject.toml 时，默认写 Python 语言配置", () => withTemporaryDirectory("init", async (dir) => {
    writeProjectMarkers(dir, { "pyproject.toml": "[project]\nname = 'example'\n" });

    const result = await Effect.runPromise(writeInitConfig(dir));
    const config = readFileSync(result.configPath, "utf8");

    expect(config).toContain('languages: ["python"]');
  }));

  it("为任意已探测的语言组合生成彼此独立的观察策略", () => withTemporaryDirectory("init", async (dir) => {
    writeProjectMarkers(dir, {
      "pyproject.toml": "[project]\nname = 'example'\n",
      "Cargo.toml": "[package]\nname = \"example\"\nversion = \"0.1.0\"\n",
    });

    const result = await Effect.runPromise(writeInitConfig(dir));
    const config = readFileSync(result.configPath, "utf8");

    expect(config).toContain('languages: ["rust", "python"]');
    expect(config).toContain('id: "rust-observe"');
    expect(config).toContain('languages: ["rust"]');
    expect(config).toContain('id: "python-observe"');
    expect(config).toContain('languages: ["python"]');
    expect(config).not.toContain("typescript-js");
    expect(config).not.toContain("go-observe");
  }));

  it("未识别语言时保留空作用域，而不伪造 TypeScript 配置", () => withTemporaryDirectory("init", async (dir) => {
    writeProjectMarkers(dir, { "project.unknown": "example\n" });

    const result = await Effect.runPromise(writeInitConfig(dir));
    const config = readFileSync(result.configPath, "utf8");

    expect(config).toContain("languages: []");
  }));

  it("在父 Git 仓库内初始化嵌套项目时，仅排除其运行时产物", () => withTemporaryDirectory("nested-init", async (root) => {
    initGit(root);
    const service = join(root, "services", "worker");
    mkdirSync(service, { recursive: true });

    await Effect.runPromise(writeInitConfig(service));
    mkdirSync(join(service, ".openarch", "pending"), { recursive: true });
    writeFileSync(join(service, ".openarch", "pending", "diff.json"), "{}\n");
    writeFileSync(join(service, ".openarch", "scan-status.json"), "{}\n");
    writeFileSync(join(service, ".openarch", "baseline.json"), "{}\n");

    const ignored = (path: string) => {
      try {
        execFileSync("git", ["check-ignore", "-q", "--", path], { cwd: root });
        return true;
      } catch { return false; }
    };
    expect(ignored("services/worker/.openarch/pending/diff.json")).toBe(true);
    expect(ignored("services/worker/.openarch/scan-status.json")).toBe(true);
    expect(ignored("services/worker/.openarch/baseline.json")).toBe(false);
  }));
});

describe("initApp hook template", () => {
  it("在没有 shared docs-repo 时默认建立可纳入项目 Git 的文档库", () => withTemporaryDirectory("init", async (dir) => {
    const result = await initApp({ cwd: dir });
    expect(result.messages.some((message) => message.includes("项目文档库"))).toBe(true);
    expect(result.messages.some((message) => message.includes("openarch context --json"))).toBe(true);
    expect(existsSync(join(dir, "docs", "openarch", "CORE-CAPABILITIES.md"))).toBe(true);
  }));

  it("安装默认脚本时报告实际路径与验证命令", () => withTemporaryDirectory("init-script", async (dir) => {
    writeProjectMarkers(dir, { "pyproject.toml": "[project]\nname = 'example'\n" });

    const result = await initApp({
      cwd: dir,
      defaultScripts: ["anti-patterns.python.placeholder-implementation"],
    });

    expect(result.messages).toContain("    路径: .openarch/anti-patterns/rules/python-placeholder-implementation.mjs");
    expect(result.messages).toContain("  验证已安装脚本: openarch rules check");
    expect(result.messages).toContain("  校准/回扫: openarch rules scan");
  }));

  it("以 personal 模式初始化时仍建立完整项目边界", () => withTemporaryDirectory("personal-init", async (dir) => {
    mkdirSync(join(dir, ".git"), { recursive: true });

    const result = await initApp({ cwd: dir, persistence: "local" });

    expect(result.code).toBe(0);
    expect(readFileSync(join(dir, ".openarch", "config.yml"), "utf8")).toContain("persistence: local");
    expect(existsSync(join(dir, "docs", "openarch", "CORE-CAPABILITIES.md"))).toBe(true);
    expect(result.messages).toContain("  未安装 OpenArch hook；如需提交时验证，请额外运行: openarch init --install-hook");
  }));

  it("可在初始化时安装当前项目的 Agent Skill", () => withTemporaryDirectory("agent-skill-init", async (dir) => {
    const result = await initApp({ cwd: dir, agentSkillTarget: "claude" });

    expect(result.code).toBe(0);
    expect(existsSync(join(dir, ".claude", "skills", "openarch", "SKILL.md"))).toBe(true);
    expect(result.messages.some((message) => message.includes("OpenArch Skill 已安装"))).toBe(true);
  }));

  it("只在显式提供地址时配置本机协调服务，且不把它混同为 docs-repo", () => withTemporaryDirectory("coordination-init", async (dir) => {
    const configured = await initApp({ cwd: dir, coordinationUrl: "https://coordination.example.test/api/" });

    expect(configured.code).toBe(0);
    expect(configured.messages.join("\n")).toContain("协调服务地址已配置: https://coordination.example.test/api");
    expect(readCoordinationConfig(dir)).toEqual({
      state: "configured",
      path: join(dir, ".openarch", "coordination.json"),
      config: { version: 1, url: "https://coordination.example.test/api" },
    });
    expect(readFileSync(join(dir, ".openarch", ".gitignore"), "utf8")).toContain("coordination.json");
    expect(existsSync(join(dir, ".openarch", ".docs-repo-config.json"))).toBe(false);

    const cleared = await initApp({ cwd: dir, clearCoordination: true });
    expect(cleared.messages).toContain("✓ 协调服务地址已清除");
    expect(readCoordinationConfig(dir).state).toBe("not_configured");
  }));

  it("拒绝含凭据或查询参数的协调服务地址", () => withTemporaryDirectory("coordination-invalid", async (dir) => {
    const result = await initApp({ cwd: dir, coordinationUrl: "https://user:secret@coordination.example.test/?token=secret" });

    expect(result.code).toBe(3);
    expect(result.messages.join("\n")).toContain("协调服务配置失败");
    expect(readCoordinationConfig(dir).state).toBe("not_configured");
  }));

  it("defers language filtering to check and stages only generated governance artifacts", () => withTemporaryDirectory("init", async (dir) => {
    mkdirSync(join(dir, ".git"), { recursive: true });

    await initApp({ cwd: dir, installHook: true });

    const hook = readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf8");
    expect(hook).toContain("check --pre-commit");
    expect(hook).toContain("docs check --staged");
    expect(hook).toContain("OPENARCH_BIN");
    expect(hook).not.toContain("packages/cli/bin/openarch.js");
    expect(hook).not.toContain("grep '\\.ts");
    expect(hook).toContain("stage_changed_governance_artifacts");
    expect(hook).not.toContain("git add -- .openarch/baseline .openarch/history .openarch/audit");
    expect(hook.indexOf("check --staged --report")).toBeLessThan(hook.indexOf("check --pre-commit"));
    expect(hook.indexOf("check --pre-commit")).toBeLessThan(hook.lastIndexOf("stage_changed_governance_artifacts"));
    expect(hook.indexOf("docs check --staged")).toBeLessThan(hook.lastIndexOf("stage_changed_governance_artifacts"));
  }));

  it("does not stage pre-existing governance drift when sealing current evidence", () => withTemporaryDirectory("hook-boundary", async (dir) => {
    initGit(dir);
    mkdirSync(join(dir, ".openarch", "baseline"), { recursive: true });
    writeFileSync(join(dir, ".openarch", "baseline", "preexisting.json"), '{"version":1}\n');
    writeFileSync(join(dir, "source.ts"), "export const version = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "--quiet", "--no-verify", "-m", "seed"], { cwd: dir });
    await initApp({ cwd: dir, installHook: true });

    writeFileSync(join(dir, ".openarch", "baseline", "preexisting.json"), '{"version":2}\n');
    writeFileSync(join(dir, "source.ts"), "export const version = 2;\n");
    execFileSync("git", ["add", "source.ts"], { cwd: dir });
    const executable = join(dir, "openarch-stub");
    writeFileSync(executable, `#!/bin/sh
printf '%s %s\\n' "$1" "$2" >> .openarch/hook-commands.log
if [ "$1" = "check" ] && [ "$2" = "--pre-commit" ]; then
  mkdir -p .openarch/history
  printf '{"sealed":true}\\n' > .openarch/history/current.json
fi
exit 0
`);
    chmodSync(executable, 0o755);

    execFileSync("git", ["commit", "--quiet", "-m", "scoped governance artifacts"], {
      cwd: dir,
      env: { ...process.env, OPENARCH_BIN: executable.replace(/\\/g, "/") },
    });
    const committed = execFileSync("git", ["show", "--format=", "--name-only", "HEAD"], { cwd: dir, encoding: "utf8" }).split(/\r?\n/);
    expect(readFileSync(join(dir, ".openarch", "hook-commands.log"), "utf8")).toContain("check --pre-commit");
    expect(existsSync(join(dir, ".openarch", "history", "current.json"))).toBe(true);
    expect(committed).toContain("source.ts");
    expect(committed).toContain(".openarch/history/current.json");
    expect(committed).not.toContain(".openarch/baseline/preexisting.json");
  }));

  it("keeps local persistence artifacts out of a real hook-created commit", () => withTemporaryDirectory("personal-hook", async (dir) => {
    initGit(dir);
    writeFileSync(join(dir, "source.ts"), "export const version = 1;\n");
    execFileSync("git", ["add", "source.ts"], { cwd: dir });
    execFileSync("git", ["commit", "--quiet", "--no-verify", "-m", "seed"], { cwd: dir });

    await initApp({ cwd: dir, persistence: "local", installHook: true });
    writeFileSync(join(dir, "source.ts"), "export const version = 2;\n");
    execFileSync("git", ["add", "source.ts"], { cwd: dir });
    const executable = join(dir, "openarch-stub");
    writeFileSync(executable, [
      "#!/bin/sh",
      "if [ \"$1\" = \"check\" ] && [ \"$2\" = \"--pre-commit\" ]; then",
      "  mkdir -p .openarch/history",
      "  printf '{\"sealed\":true}\\n' > .openarch/history/current.json",
      "fi",
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(executable, 0o755);

    execFileSync("git", ["commit", "--quiet", "-m", "local governance"], {
      cwd: dir,
      env: { ...process.env, OPENARCH_BIN: executable.replace(/\\/g, "/") },
    });

    const committed = execFileSync("git", ["show", "--format=", "--name-only", "HEAD"], { cwd: dir, encoding: "utf8" });
    expect(existsSync(join(dir, ".openarch", "history", "current.json"))).toBe(true);
    expect(committed).toContain("source.ts");
    expect(committed).not.toContain(".openarch/history/current.json");
  }));

  it("updates a previously generated OpenArch hook but preserves a foreign hook", () => withTemporaryDirectory("init", async (managed) => {
    mkdirSync(join(managed, ".git", "hooks"), { recursive: true });
    writeFileSync(join(managed, ".git", "hooks", "pre-commit"), "# OpenArch pre-commit hook\nold", "utf8");
    const updated = await initApp({ cwd: managed, installHook: true });
    expect(updated.messages).toContain("✓ pre-commit hook 已更新");
    expect(readFileSync(join(managed, ".git", "hooks", "pre-commit"), "utf8")).toContain("seal matching semantic evidence");

    await withTemporaryDirectory("init", async (foreign) => {
    mkdirSync(join(foreign, ".git", "hooks"), { recursive: true });
    writeFileSync(join(foreign, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho custom", "utf8");
    const skipped = await initApp({ cwd: foreign, installHook: true });
    expect(skipped.messages).toContain("  (pre-commit hook 已存在，跳过)");
    expect(readFileSync(join(foreign, ".git", "hooks", "pre-commit"), "utf8")).toContain("echo custom");
    });
  }));

  it("does not repeat shared-document similarity checks in the code repository hook", () => withTemporaryDirectory("project", async (project) => withTemporaryDirectory("docs", async (docs) => {
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(join(project, ".openarch", "docs-repo"), { recursive: true });
    mkdirSync(join(docs, ".git"), { recursive: true });
    writeFileSync(join(project, ".openarch", ".docs-repo-config.json"), JSON.stringify({
      version: "5.2", target: docs, type: "local", cloned_at: "2026-07-16T00:00:00.000Z", auto_sync: false,
    }));
    writeFileSync(join(project, ".openarch", "document-store.json"), JSON.stringify({
      version: "1", mode: "shared", scopeRoot: "projects/service-a", scopeId: "repository:service-a",
    }));

    await initApp({ cwd: project, installHook: true });

    expect(readFileSync(join(project, ".git", "hooks", "pre-commit"), "utf8")).not.toContain("docs check --staged");
  })));

  it("reports the explicitly bound shared scope instead of deriving a basename path", () => withTemporaryDirectory("project", async (project) => withTemporaryDirectory("docs", async (docs) => {
    mkdirSync(join(project, ".openarch", "docs-repo"), { recursive: true });
    mkdirSync(join(docs, ".git"), { recursive: true });
    writeFileSync(join(project, ".openarch", ".docs-repo-config.json"), JSON.stringify({
      version: "5.2", target: docs, type: "local", cloned_at: "2026-07-17T00:00:00.000Z", auto_sync: false,
    }));
    writeFileSync(join(project, ".openarch", "document-store.json"), JSON.stringify({
      version: "1", mode: "shared", scopeRoot: "services/catalog-docs", scopeId: "repository:catalog",
    }));
    mkdirSync(join(docs, "services", "catalog-docs"), { recursive: true });
    writeFileSync(join(docs, "services", "catalog-docs", "CORE-CAPABILITIES.md"), "# Catalog\n");

    const result = await initApp({ cwd: project });

    expect(result.messages).toContain(`  文档 scope: repository:catalog (${join(docs, "services", "catalog-docs")})`);
    expect(result.messages).toContain(`  能力清单: ${join(docs, "services", "catalog-docs", "CORE-CAPABILITIES.md")} (已存在)`);
    expect(result.messages.join("\n")).not.toContain("projects/openarch");
  })));
});
