import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readGovernancePersistence, readHistoryRetentionPolicy, syncGovernancePersistence } from "../../src/application/governancePersistence";

const directories: string[] = [];

const project = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "openarch-persistence-"));
  directories.push(cwd);
  execFileSync("git", ["init", "--quiet"], { cwd });
  mkdirSync(join(cwd, ".openarch"), { recursive: true });
  writeFileSync(join(cwd, ".openarch", "config.yml"), "languages: [python]\n");
  return cwd;
};

afterEach(() => {
  for (const cwd of directories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("governance persistence", () => {
  it("treats legacy config as tracked until an explicit migration", async () => {
    const cwd = project();

    expect(await readGovernancePersistence(cwd)).toBe("tracked");

    const first = await syncGovernancePersistence(cwd, "local");
    const second = await syncGovernancePersistence(cwd, "local");
    const config = readFileSync(join(cwd, ".openarch", "config.yml"), "utf8");
    const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");

    expect(first).toMatchObject({ persistence: "local", configChanged: true, exclude: "updated" });
    expect(second).toMatchObject({ persistence: "local", configChanged: false, exclude: "unchanged" });
    expect(config).toContain("governance:\n  persistence: local");
    expect(exclude).toContain("# OpenArch local persistence\n.openarch/");
    expect(existsSync(join(cwd, ".openarch", "config.yml"))).toBe(true);
  });

  it("removes only its managed local exclude block when returning to tracked", async () => {
    const cwd = project();
    const exclude = join(cwd, ".git", "info", "exclude");
    writeFileSync(exclude, "custom-cache/\n# OpenArch local persistence\n.openarch/\n");

    const result = await syncGovernancePersistence(cwd, "tracked");

    expect(result).toMatchObject({ persistence: "tracked", exclude: "updated" });
    expect(readFileSync(exclude, "utf8")).toContain("custom-cache/");
    expect(readFileSync(exclude, "utf8")).not.toContain("OpenArch local persistence");
  });

  it("reports tracked OpenArch files without removing them", async () => {
    const cwd = project();
    execFileSync("git", ["add", "-f", ".openarch/config.yml"], { cwd });

    const result = await syncGovernancePersistence(cwd, "local");

    expect(result.trackedPaths).toEqual([".openarch/config.yml"]);
    expect(execFileSync("git", ["ls-files", "--", ".openarch/config.yml"], { cwd, encoding: "utf8" }).trim()).toBe(".openarch/config.yml");
  });

  it("uses an explicit history raw window when configured and a stable default for legacy projects", async () => {
    const cwd = project();
    expect(await readHistoryRetentionPolicy(cwd)).toEqual({ rawWindowDays: 180 });

    writeFileSync(join(cwd, ".openarch", "config.yml"), "governance:\n  history:\n    raw_window_days: 14\n");
    expect(await readHistoryRetentionPolicy(cwd)).toEqual({ rawWindowDays: 14 });

    writeFileSync(join(cwd, ".openarch", "config.yml"), "governance:\n  history:\n    raw_window_days: 0\n");
    await expect(readHistoryRetentionPolicy(cwd)).rejects.toThrow("integer from 1 through 3650");
  });

  it("updates only governance.persistence, not an unrelated top-level key", async () => {
    const cwd = project();
    writeFileSync(join(cwd, ".openarch", "config.yml"), "persistence: legacy\nproject: demo\ngovernance:\n  history:\n    raw_window_days: 14\n");
    await syncGovernancePersistence(cwd, "local");
    const config = readFileSync(join(cwd, ".openarch", "config.yml"), "utf8");
    expect(config).toContain("persistence: legacy");
    expect(config).toContain("governance:\n  persistence: local");
  });
});
