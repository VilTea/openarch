import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type MessageKey, message, messageKeys, resolveLocale } from "../../src/i18n";

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

describe("CLI presentation catalog", () => {
  // 一个概念只有一个权威定义：zh 是键集合的 authority，en 必须逐键对齐。
  it("keeps zh/en key parity", () => {
    expect(messageKeys("en")).toEqual(messageKeys("zh"));
  });

  // 模板占位符也是契约：zh 插值的参数，en 必须同样插值，否则同一事实两种语言渲染结构不同。
  it("keeps zh/en placeholder parity per key", () => {
    const placeholders = (locale: "zh" | "en", key: MessageKey): readonly string[] =>
      [...message(locale, key, {}).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

    for (const key of messageKeys("zh")) {
      expect(placeholders("en", key), key).toEqual(placeholders("zh", key));
    }
  });
});
