#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const valueFor = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const target = valueFor("--target");
const requestedLocale = valueFor("--locale");
/**
 * 目标清单必须与 core 的 `AGENT_SKILL_TARGETS` 一致（唯一权威）。
 *
 * 本 bin 刻意**不依赖** `@openarch/core`（插件包 `dependencies` 为空，要在 `npx` 安装前就能跑），
 * 所以这里只能保留一份副本 —— 2026-09-27 复验证明这正是漏掉 `reasonix` 的原因
 * （`--target reasonix` 直接 exit 2，而项目级 `openarch init --agent reasonix` 一直是支持的）。
 * 副本由 `packages/cli/__tests__/unit/pluginInstaller.test.ts` 的"逐目标安装"守卫盯着：
 * 任何一边增删目标，守卫立刻变红。
 */
const supportedTargets = new Set(["claude", "codex", "cursor", "opencode", "reasonix", "dsh"]);
const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh") ? "zh" : "en";
const locale = requestedLocale ?? systemLocale;

if (process.argv.includes("--preset")) {
  console.error("DSH preset is not stable and has been removed. Install the DSH bundle instead (add @openarch/plugin to dsh.profile.bundles).");
  process.exit(2);
}

if (!target || !supportedTargets.has(target) || !["zh", "en"].includes(locale) || process.argv.includes("--scope")) {
  console.error("Usage: openarch-agent-install --target <claude|codex|cursor|opencode|reasonix|dsh> [--locale <zh|en>]");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skill = resolve(root, "assets", "agent-skills", "openarch", "locales", locale);
const userRoots = {
  claude: resolve(homedir(), ".claude"),
  codex: process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
  cursor: resolve(homedir(), ".cursor"),
  opencode: resolve(homedir(), ".config", "opencode"),
  // 与项目级 `targetRoots.reasonix = ".reasonix/skills"`（core agentSkill）和 CLI 的
  // `detectHarness()`（`REASONIX_SESSION`/`REASONIX_HOME`）同一约定。
  reasonix: process.env.REASONIX_HOME ?? resolve(homedir(), ".reasonix"),
  dsh: process.env.DSH_HOME ?? resolve(homedir(), ".dsh"),
};

const recoverBackup = (destination, backupPrefix) => {
  if (existsSync(destination)) return;
  const parent = dirname(destination);
  let names;
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  const backup = names.filter((name) => name.startsWith(backupPrefix)).sort().at(-1);
  if (backup) {
    try {
      renameSync(join(parent, backup), destination);
    } catch {
      // 恢复失败不阻塞：下一次安装仍会重建目标目录。
    }
  }
};

const replaceDirectory = (source, destination) => {
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  recoverBackup(destination, ".openarch-skill-backup-");
  const suffix = `${process.pid}-${Date.now()}`;
  const staging = resolve(parent, `.openarch-skill-staging-${suffix}`);
  const backup = resolve(parent, `.openarch-skill-backup-${suffix}`);
  try {
    cpSync(source, staging, { recursive: true });
    if (existsSync(destination)) renameSync(destination, backup);
    renameSync(staging, destination);
  } catch (error) {
    if (existsSync(backup) && !existsSync(destination)) renameSync(backup, destination);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
  }
};

if (!existsSync(skill)) {
  console.error("OpenArch Skill 资产缺失，安装包可能不完整。");
  process.exit(3);
}

const destination = resolve(resolve(userRoots[target], "skills"), "openarch");
replaceDirectory(skill, destination);
console.log(`Installed OpenArch Skill (${locale}): ${destination}`);
