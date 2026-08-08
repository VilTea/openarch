import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeToolchainConfig } from "../../src/application/toolchainConfigSetup";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("initializeToolchainConfig", () => {
  it("creates an idempotent checkout-local configuration", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openarch-toolchain-config-"));
    roots.push(cwd);

    const first = await initializeToolchainConfig({ cwd, scope: "project" });
    const second = await initializeToolchainConfig({ cwd, scope: "project" });

    expect(first).toMatchObject({ created: true, path: join(cwd, ".openarch", "toolchains.local.yml") });
    expect(second).toMatchObject({ created: false, path: join(cwd, ".openarch", "toolchains.local.yml") });
    expect(existsSync(join(cwd, ".openarch", "toolchains.local.yml"))).toBe(true);
  });

  it("uses the platform user configuration convention without touching a project", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openarch-toolchain-user-"));
    const appData = join(cwd, "AppData", "Roaming");
    roots.push(cwd);

    const result = await initializeToolchainConfig({ cwd, scope: "user", platform: "win32", environment: { APPDATA: appData } });

    expect(result).toMatchObject({ created: true, path: join(appData, "OpenArch", "toolchains.yml") });
    expect(existsSync(join(appData, "OpenArch", "toolchains.yml"))).toBe(true);
  });

  it("keeps the checkout-local override out of Git without changing repository policy", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openarch-toolchain-exclude-"));
    roots.push(cwd);
    execFileSync("git", ["init", "-q"], { cwd });

    const first = await initializeToolchainConfig({ cwd, scope: "project" });
    const second = await initializeToolchainConfig({ cwd, scope: "project" });
    const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");

    expect(first).toMatchObject({ exclude: "updated" });
    expect(second).toMatchObject({ exclude: "unchanged" });
    expect(exclude.match(/\.openarch\/toolchains\.local\.yml/g)).toHaveLength(1);
  });
});
