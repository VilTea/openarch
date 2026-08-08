import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hookExecutableAvailable, renderGovernanceArtifactStager, renderHookLauncher, renderHookPersistenceResolver } from "../../src/hook/HookLauncher";

describe("HookLauncher", () => {
  it("finds a project-local OpenArch shim before relying on PATH", () => {
    const cwd = join(tmpdir(), `openarch-hook-${Date.now()}`);
    const bin = join(cwd, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, process.platform === "win32" ? "openarch.cmd" : "openarch"), "shim");

    expect(hookExecutableAvailable("openarch", cwd)).toBe(true);
  });

  it("emits one project-local execution function for installed CLI packages", () => {
    const launcher = renderHookLauncher("enforcing", "OpenArch");
    expect(launcher).toContain('openarch_exec()');
    expect(launcher).toContain('$PWD/node_modules/@openarch/cli/bin/openarch.js');
    expect(launcher).toContain('command -v node.exe');
    expect(launcher).toContain('wslpath -w "$PWD"');
    expect(launcher).toContain('cygpath -w "$PWD"');
  });

  it("stages only governance artifacts changed during the hook invocation", () => {
    const stager = renderGovernanceArtifactStager();
    expect(stager).toContain("snapshot_governance_artifacts");
    expect(stager).toContain("git hash-object");
    expect(stager).toContain("HASH_BATCH_MAX_FILES=32");
    expect(stager).toContain("HASH_BATCH_MAX_BYTES=8192");
    expect(stager).toContain('git hash-object -- "${batch[@]}"');
    expect(stager).not.toContain('$(git hash-object "$path")');
    expect(stager).toContain("awk -F '\\t'");
    expect(stager).not.toContain("grep -F -x -q");
    expect(stager).toContain("stage_changed_governance_artifacts");
    expect(stager).toContain("git ls-files --error-unmatch");
    expect(stager).not.toContain("git add -- .openarch/baseline .openarch/history .openarch/audit");
  });

  it("reads persistence from config at hook runtime and rejects invalid values", () => {
    const resolver = renderHookPersistenceResolver();
    expect(resolver).toContain("governance:");
    expect(resolver).toContain("persistence:");
    expect(resolver).toContain('OPENARCH_PERSISTENCE="$' + '{OPENARCH_PERSISTENCE:-tracked}"');
    expect(resolver).toContain("local|tracked");
    expect(resolver).not.toContain("\\n");
  });
});
