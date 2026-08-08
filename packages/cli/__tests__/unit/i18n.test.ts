import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveLocale } from "../../src/i18n";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const projectWithLocale = (locale: string): string => {
  const cwd = mkdtempSync(join(tmpdir(), "openarch-locale-config-"));
  temporaryDirectories.push(cwd);
  mkdirSync(join(cwd, ".openarch"));
  writeFileSync(join(cwd, ".openarch", "config.yml"), `presentation:\n  locale: ${locale}\n`);
  return cwd;
};

describe("CLI locale resolution", () => {
  it("uses an explicit locale ahead of environment and system defaults", () => {
    expect(resolveLocale(["review", "--lang", "zh"], process.cwd(), { OPENARCH_LANG: "en" })).toMatchObject({
      locale: "zh",
      args: ["review"],
    });
  });

  it("uses OPENARCH_LANG when no flag is present", () => {
    expect(resolveLocale(["review"], process.cwd(), { OPENARCH_LANG: "zh-CN" })).toMatchObject({
      locale: "zh",
      args: ["review"],
    });
  });

  it("uses the project presentation locale when no explicit override exists", () => {
    expect(resolveLocale(["review"], projectWithLocale("zh"), {})).toMatchObject({ locale: "zh", args: ["review"] });
  });

  it("lets an explicit language override the project presentation default", () => {
    expect(resolveLocale(["review", "--lang", "en"], projectWithLocale("zh"), {})).toMatchObject({ locale: "en", args: ["review"] });
  });

  it("reports an invalid configured locale when no higher-priority override exists", () => {
    expect(resolveLocale(["review"], projectWithLocale("fr"), {})).toMatchObject({ error: expect.stringContaining("presentation.locale") });
  });
});
