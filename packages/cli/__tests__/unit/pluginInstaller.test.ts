import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const installer = resolve(process.cwd(), "..", "openarch-plugin", "bin", "openarch-agent-install.js");

const withTemporaryHome = (run: (home: string) => void): void => {
  const home = mkdtempSync(join(tmpdir(), "openarch-plugin-installer-"));
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

describe("standalone plugin Skill installer", () => {
  it("installs the requested user-scoped locale without a project configuration", () => withTemporaryHome((home) => {
    const result = spawnSync(process.execPath, [installer, "--target", "codex", "--locale", "zh"], {
      cwd: home,
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    const skill = join(home, ".codex", "skills", "openarch", "SKILL.md");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("(zh)");
    expect(existsSync(skill)).toBe(true);
    expect(readFileSync(skill, "utf8")).toContain("OpenArch 治理宪法");
    writeFileSync(join(home, ".codex", "skills", "openarch", "README.md"), "legacy asset");
    const update = spawnSync(process.execPath, [installer, "--target", "codex", "--locale", "zh"], {
      cwd: home,
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    expect(update.status).toBe(0);
    expect(existsSync(join(home, ".codex", "skills", "openarch", "README.md"))).toBe(false);
  }));

  it("rejects the retired project scope instead of bypassing CLI locale selection", () => withTemporaryHome((home) => {
    const result = spawnSync(process.execPath, [installer, "--target", "codex", "--scope", "project"], {
      cwd: home,
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  }));
});
