import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT_SKILL_TARGETS } from "@openarch/core";

const testDir = dirname(fileURLToPath(import.meta.url));
const installer = resolve(testDir, "..", "..", "..", "openarch-plugin", "bin", "openarch-agent-install.js");

/**
 * 用户级安装的落点（与 `bin/openarch-agent-install.js` 的 `userRoots` 同一口径）。
 * 测试用 `USERPROFILE`/`HOME` 指向临时目录，因此这里都相对该目录。
 */
const USER_SKILL_ROOTS: Record<(typeof AGENT_SKILL_TARGETS)[number], string> = {
  claude: ".claude/skills/openarch",
  codex: ".codex/skills/openarch",
  cursor: ".cursor/skills/openarch",
  opencode: ".config/opencode/skills/openarch",
  reasonix: ".reasonix/skills/openarch",
  dsh: ".dsh/skills/openarch",
};

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

  it("rejects the removed DSH preset flag for any target", () => withTemporaryHome((home) => {
    const result = spawnSync(process.execPath, [installer, "--target", "dsh", "--preset"], {
      cwd: home,
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("DSH preset is not stable and has been removed");
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

  /**
   * 目标清单的**行为守卫**（2026-09-27 复验发现的真缺陷）：用户级安装器曾漏掉 `reasonix`
   * （`--target reasonix` → exit 2），而 core 的 `AGENT_SKILL_TARGETS` 与 CLI `--agent` 一直是 6 个
   * —— 同一个事实两份清单，且没有任何东西盯着它们相等。
   *
   * 这里**不比对清单文本**（那只是抄一遍），而是对权威列表里的每个目标**真跑一次安装器**
   * 并断言落点存在：任何一边增删目标，这条立刻红。
   */
  it("installs every target the core authority declares (no parallel-list drift)", () => withTemporaryHome((home) => {
    for (const target of AGENT_SKILL_TARGETS) {
      const result = spawnSync(process.execPath, [installer, "--target", target, "--locale", "en"], {
        cwd: home,
        encoding: "utf8",
        // 宿主环境可能已带着 `DSH_HOME`/`CODEX_HOME`/`REASONIX_HOME`（跑测试的 Agent 自己就在这类宿主里），
        // 因此把三个覆盖变量都钉到临时 HOME，保证断言路径与"默认落点"一致。
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: join(home, ".codex"),
          REASONIX_HOME: join(home, ".reasonix"),
          DSH_HOME: join(home, ".dsh"),
        },
      });
      const skill = join(home, USER_SKILL_ROOTS[target], "SKILL.md");
      expect(result.status, `${target}: ${result.stderr}`).toBe(0);
      expect(existsSync(skill), `${target}: 未落到 ${USER_SKILL_ROOTS[target]}`).toBe(true);
      expect(readFileSync(skill, "utf8")).toContain("OpenArch Governance Constitution");
    }
  }));
});
