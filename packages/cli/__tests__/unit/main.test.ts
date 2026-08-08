import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../../src/main";
import { OPENARCH_VERSION } from "../../src/version";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("runCli help boundary", () => {
  it("prints the packaged version without resolving project configuration", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["--version"], "Z:/does-not-exist")).resolves.toBe(0);

    expect(output).toHaveBeenCalledWith(OPENARCH_VERSION);
  });

  it("prints init help without invoking initialization", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openarch-init-help-"));
    temporaryDirectories.push(cwd);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["init", "--help"], cwd)).resolves.toBe(0);

    expect(output).toHaveBeenCalledWith(expect.stringContaining("--install-hook"));
    expect(existsSync(join(cwd, ".openarch"))).toBe(false);
  });

  it("explains record categories without generating a document", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openarch-record-help-"));
    temporaryDirectories.push(cwd);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["docs", "record", "--help"], cwd)).resolves.toBe(0);

    expect(output).toHaveBeenCalledWith(expect.stringContaining("anti_patterns"));
    expect(existsSync(join(cwd, ".openarch"))).toBe(false);
  });

  it("rejects an invalid init persistence mode before writing project files", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openarch-init-mode-"));
    temporaryDirectories.push(cwd);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runCli(["init", "--mode", "shared"], cwd)).resolves.toBe(3);

    expect(error).toHaveBeenCalledWith("--mode 只能是 personal 或 team");
    expect(existsSync(join(cwd, ".openarch"))).toBe(false);
  });

  it("rejects an unsupported agent target before writing project files", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openarch-init-agent-"));
    temporaryDirectories.push(cwd);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runCli(["init", "--agent", "unknown"], cwd)).resolves.toBe(3);

    expect(error).toHaveBeenCalledWith("--agent 只能是 claude、codex、cursor、opencode、reasonix");
    expect(existsSync(join(cwd, ".openarch"))).toBe(false);
  });

  it("accepts a global locale flag before or after the command", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openarch-locale-"));
    temporaryDirectories.push(cwd);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["--lang", "en", "init", "--help"], cwd)).resolves.toBe(0);
    expect(output).toHaveBeenLastCalledWith(expect.stringContaining("Initialize governance boundaries"));

    await expect(runCli(["init", "--help", "--lang=zh"], cwd)).resolves.toBe(0);
    expect(output).toHaveBeenLastCalledWith(expect.stringContaining("初始化治理边界"));
  });

  it("uses the project presentation locale when no language flag is supplied", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openarch-project-locale-"));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, ".openarch"));
    writeFileSync(join(cwd, ".openarch", "config.yml"), "presentation:\n  locale: en\n");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["--help"], cwd)).resolves.toBe(0);

    expect(output).toHaveBeenCalledWith(expect.stringContaining("Commands:"));
  });

  it("rejects an unsupported locale before a command can run", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runCli(["--lang", "fr", "--help"])).resolves.toBe(3);

    expect(error).toHaveBeenCalledWith(expect.stringMatching(/--lang/));
  });
});
