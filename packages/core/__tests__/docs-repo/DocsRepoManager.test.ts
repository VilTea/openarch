// packages/core/__tests__/docs-repo/DocsRepoManager.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

const childProcess = vi.hoisted(() => ({ execFileSync: vi.fn(), execSync: vi.fn() }));
vi.mock("node:child_process", () => childProcess);
import { associateFromLocal, unlinkDocsRepo, statusDocsRepo } from "../../src/docs-repo/DocsRepoManager";
import { associateFromUrl } from "../../src/docs-repo/DocsRepoManager";
import { createSymlink, readSymlinkTarget, removeSymlink } from "../../src/docs-repo/SymlinkManager";

const tempDir = () => join(tmpdir(), `openarch-docs-${Date.now()}-${Math.random().toString(36).slice(2)}`);

describe("SymlinkManager", () => {
  it("createSymlink → readSymlinkTarget → removeSymlink", () => {
    const dir = tempDir();
    const target = join(dir, "target");
    const link = join(dir, "link");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "README.md"), "# docs");

    const r = createSymlink(target, link);
    expect(["symlink", "junction", "text"]).toContain(r.method);

    const resolved = readSymlinkTarget(link);
    if (r.method !== "text") {
      expect(resolved).toBe(target); // POSIX symlink/junction 可读回 target
    }

    removeSymlink(link);
    expect(existsSync(link)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("DocsRepoManager", () => {
  it("passes an untrusted remote as one Git argument and derives a contained clone target", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".openarch"), { recursive: true });
    const remote = 'https://host/team/../../docs.git";$(unexpected)';

    const result = associateFromUrl(remote, cwd);

    expect(childProcess.execFileSync).toHaveBeenCalledOnce();
    const [program, args] = childProcess.execFileSync.mock.calls[0];
    expect(program).toBe("git");
    expect(args.slice(0, 4)).toEqual(["clone", "--depth=1", "--", remote]);
    expect(relative(join(cwd, ".openarch", ".docs-repo-cache"), result.config.target)).not.toMatch(/(^|[\\/])\.\.([\\/]|$)/);
    expect(result.config.target).toMatch(/[\\/]repo-[0-9a-f]{24}$/);

    rmSync(cwd, { recursive: true, force: true });
  });

  it("associateFromLocal → 创建 symlink + config → status 正确", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".openarch"), { recursive: true });
    const docsDir = join(cwd, "my-docs");
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(join(docsDir, ".git"));
    writeFileSync(join(docsDir, "README.md"), "# team docs");

    const result = associateFromLocal(docsDir, cwd);
    expect(result).toHaveProperty("config");
    if ("error" in result) throw new Error(result.error);
    expect(result.config.type).toBe("local");
    expect(result.config.target).toContain("my-docs");
    expect(existsSync(join(docsDir, "projects", "_template", "CORE-CAPABILITIES.md"))).toBe(false);

    // status
    const st = statusDocsRepo(cwd);
    expect(st.associated).toBe(true);
    expect(st.symlinkValid).toBe(true);

    // 幂等：重复调用
    const firstConfig = readFileSync(join(cwd, ".openarch", ".docs-repo-config.json"), "utf8");
    const r2 = associateFromLocal(docsDir, cwd);
    if ("error" in r2) throw new Error(r2.error);
    expect(r2.wasCloned).toBe(false); // local always false
    expect(readFileSync(join(cwd, ".openarch", ".docs-repo-config.json"), "utf8")).toBe(firstConfig);

    rmSync(cwd, { recursive: true, force: true });
  });

  it("unlinkDocsRepo → symlink 移除 + config 备份", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".openarch"), { recursive: true });
    const docsDir = join(cwd, "my-docs");
    mkdirSync(docsDir, { recursive: true });

    associateFromLocal(docsDir, cwd);
    const result = unlinkDocsRepo(cwd);
    expect(result.unlinked).toBe(true);
    expect(result.configBackupPath).not.toBeNull();

    // 确认 symlink 已移除
    const st = statusDocsRepo(cwd);
    expect(st.symlinkValid).toBe(false);

    rmSync(cwd, { recursive: true, force: true });
  });
});
