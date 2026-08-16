import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const installer = resolve(testDir, "..", "..", "..", "openarch-plugin", "bin", "openarch-agent-install.js");

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

  it("installs the DeepSeek Harness user-scoped skill under DSH_HOME", () => withTemporaryHome((home) => {
    const result = spawnSync(process.execPath, [installer, "--target", "dsh", "--locale", "en"], {
      cwd: home,
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: join(home, ".dsh") },
    });
    const skill = join(home, ".dsh", "skills", "openarch", "SKILL.md");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("(en)");
    expect(existsSync(skill)).toBe(true);
    expect(readFileSync(skill, "utf8")).toContain("OpenArch Governance Constitution");
  }));

  it("installs the DeepSeek Harness agent preset with localized skills under DSH_HOME", () => withTemporaryHome((home) => {
    const dshHome = join(home, ".dsh");
    const result = spawnSync(process.execPath, [installer, "--target", "dsh", "--locale", "zh", "--preset"], {
      cwd: home,
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: dshHome },
    });
    const preset = join(dshHome, ".agent-presets", "openarch");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DSH preset");
    expect(existsSync(join(preset, "agent.cordis.yml"))).toBe(true);
    expect(existsSync(join(preset, "preset.yml"))).toBe(true);
    expect(existsSync(join(preset, "skills", "openarch-zh", "SKILL.md"))).toBe(true);
    expect(existsSync(join(preset, "skills", "openarch-en", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(preset, "agent.cordis.yml"), "utf8")).toContain("customSkillDirs");
  }));

  it("rejects --preset for targets other than dsh", () => withTemporaryHome((home) => {
    const result = spawnSync(process.execPath, [installer, "--target", "codex", "--preset"], {
      cwd: home,
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
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
