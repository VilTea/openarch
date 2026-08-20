import { describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultScriptIdForPath, defaultScriptTarget, installDefaultScripts } from "../../src/application/defaultScripts";
import { recommendedAntiPatternAssets } from "../../src/script-runtime/defaultScriptAssets";

const tempDir = () => join(tmpdir(), `openarch-default-scripts-${Date.now()}-${Math.random().toString(36).slice(2)}`);

describe("installDefaultScripts", () => {
  it("installs matching scripts once and rejects templates, providers, and configuration templates", () => {
    const cwd = tempDir();
    const result = installDefaultScripts(cwd, ["typescript"], ["anti-patterns.typescript.no-empty-catch", "anti-patterns.typescript.hardcoded-project-shape", "anti-patterns.cross-language.authority-boundary", "anti-patterns.cross-language.authority-import-bypass", "implicit-deps.typescript.eventbus", "test-governance.typescript.vitest", "config.layer-weights"]);
    expect(result.installed).toEqual([
      "anti-patterns.typescript.no-empty-catch",
      "anti-patterns.typescript.hardcoded-project-shape",
      "anti-patterns.cross-language.authority-boundary",
      "anti-patterns.cross-language.authority-import-bypass",
    ]);
    expect(existsSync(join(cwd, ".openarch", "anti-patterns", "rules", "no-empty-catch.mjs"))).toBe(true);
    expect(existsSync(join(cwd, ".openarch", "anti-patterns", "rules", "hardcoded-project-shape.mjs"))).toBe(true);
    expect(existsSync(join(cwd, ".openarch", "anti-patterns", "rules", "authority-boundary.mjs"))).toBe(true);
    expect(existsSync(join(cwd, ".openarch", "anti-patterns", "rules", "authority-import-bypass.mjs"))).toBe(true);
    expect(defaultScriptTarget("anti-patterns.typescript.no-empty-catch")).toBe(".openarch/anti-patterns/rules/no-empty-catch.mjs");
    expect(result.errors).toHaveLength(3);
    expect(installDefaultScripts(cwd, ["typescript"], ["starter.staged-ast"])).toMatchObject({
      errors: ["starter.staged-ast: starter 仅由 rules skeleton 输出，不可直接安装"],
    });
    expect(installDefaultScripts(cwd, ["typescript"], ["anti-patterns.typescript.no-empty-catch"])).toMatchObject({
      installed: [], unchanged: ["anti-patterns.typescript.no-empty-catch"],
    });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("replaces only an explicitly selected default asset", () => {
    const cwd = tempDir();
    const id = "anti-patterns.typescript.no-empty-catch";
    installDefaultScripts(cwd, ["typescript"], [id]);
    const result = installDefaultScripts(cwd, ["typescript"], [id], { replace: true });
    expect(result).toMatchObject({ installed: [], replaced: [id], unchanged: [] });
    expect(defaultScriptIdForPath(join(cwd, ".openarch", "anti-patterns", "rules", "no-empty-catch.mjs"))).toBe(id);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("recognizes the Go testing provider as an enabled-by-policy asset", () => {
    const cwd = tempDir();
    const result = installDefaultScripts(cwd, ["go"], ["test-governance.go.testing"]);
    expect(result.installed).toEqual([]);
    expect(result.errors).toEqual(["test-governance.go.testing: provider 需由 Agent 配置参数或启用 provider，不可直接安装"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("recommends a matching language template without installing or enabling it", () => {
    const python = recommendedAntiPatternAssets(["python"]);
    const rust = recommendedAntiPatternAssets(["rust"]);
    const java = recommendedAntiPatternAssets(["java"]);

    expect(python).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "anti-patterns.python.placeholder-implementation",
      patternFamily: "placeholder-implementation",
    })]));
    expect(rust).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "anti-patterns.rust.placeholder-implementation",
      patternFamily: "placeholder-implementation",
    })]));
    expect(java).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "anti-patterns.java.placeholder-implementation",
      patternFamily: "placeholder-implementation",
    })]));
    expect(python).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "anti-patterns.python.silent-error-handling",
      patternFamily: "silent-error-handling",
    })]));
    expect(java).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "anti-patterns.java.silent-error-handling",
      patternFamily: "silent-error-handling",
    })]));
    expect(python).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "anti-patterns.cross-language.authority-import-bypass",
      patternFamily: "authority-import-bypass",
    })]));
  });
});
