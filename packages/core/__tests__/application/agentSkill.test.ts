import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installAgentSkill } from "../../src/application/agentSkill";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

describe("project agent Skill installation", () => {
  it("installs and then updates a known agent Skill from packaged runtime assets", () => withTemporaryDirectory("agent-skill", async (dir) => {
    const first = installAgentSkill({ cwd: dir, target: "claude" });
    const destination = join(dir, ".claude", "skills", "openarch", "SKILL.md");

    expect(first).toMatchObject({ action: "installed", locale: "en" });
    expect(existsSync(destination)).toBe(true);
    expect(readFileSync(destination, "utf8")).toContain("openarch context");
    expect(existsSync(join(dir, ".claude", "skills", "openarch", "references", "metrics-and-evidence.md"))).toBe(true);
    writeFileSync(join(dir, ".claude", "skills", "openarch", "README.md"), "legacy asset");
    expect(installAgentSkill({ cwd: dir, target: "claude" })).toMatchObject({ action: "updated" });
    expect(existsSync(join(dir, ".claude", "skills", "openarch", "README.md"))).toBe(false);
  }));

  it("supports an explicit project-local skills parent but rejects paths outside the project", () => withTemporaryDirectory("agent-skill", async (dir) => {
    const custom = installAgentSkill({ cwd: dir, skillDir: ".example-agent/skills" });

    expect(custom).toMatchObject({ action: "installed" });
    expect(existsSync(join(dir, ".example-agent", "skills", "openarch", "SKILL.md"))).toBe(true);
    expect(installAgentSkill({ cwd: dir, skillDir: "../outside/skills" })).toEqual({ error: "--skill-dir 必须是当前项目内的相对 skills 目录" });
  }));

  it("selects the project presentation locale instead of copying a mixed tree", () => withTemporaryDirectory("agent-skill", async (dir) => {
    mkdirSync(join(dir, ".openarch"));
    writeFileSync(join(dir, ".openarch", "config.yml"), "presentation:\n  locale: zh\n");
    const result = installAgentSkill({ cwd: dir, target: "claude" });
    expect(result).toMatchObject({ action: "installed", locale: "zh" });
    expect(readFileSync(join(dir, ".claude", "skills", "openarch", "SKILL.md"), "utf8")).toContain("OpenArch 治理宪法");
  }));

  it("uses English deterministically when presentation locale is missing or malformed", () => withTemporaryDirectory("agent-skill", async (dir) => {
    mkdirSync(join(dir, ".openarch"));
    writeFileSync(join(dir, ".openarch", "config.yml"), "presentation:\n  locale: fr\n");
    const result = installAgentSkill({ cwd: dir, target: "codex" });
    expect(result).toMatchObject({ action: "installed", locale: "en" });
    expect(readFileSync(join(dir, ".codex", "skills", "openarch", "SKILL.md"), "utf8")).toContain("OpenArch Governance Constitution");
  }));

  it("installs the DeepSeek Harness project skill into .dsh/skills", () => withTemporaryDirectory("agent-skill-dsh", async (dir) => {
    const result = installAgentSkill({ cwd: dir, target: "dsh" });
    expect(result).toMatchObject({ action: "installed", locale: "en" });
    expect(existsSync(join(dir, ".dsh", "skills", "openarch", "SKILL.md"))).toBe(true);
  }));
});
