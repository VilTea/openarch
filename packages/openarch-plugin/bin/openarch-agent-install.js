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
const supportedTargets = new Set(["codex", "cursor", "opencode", "claude", "dsh"]);
const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh") ? "zh" : "en";
const locale = requestedLocale ?? systemLocale;

if (process.argv.includes("--preset")) {
  console.error("DSH preset is not stable and has been removed. Install the DSH bundle instead (add @openarch/plugin to dsh.profile.bundles).");
  process.exit(2);
}

if (!target || !supportedTargets.has(target) || !["zh", "en"].includes(locale) || process.argv.includes("--scope")) {
  console.error("Usage: openarch-agent-install --target <codex|cursor|opencode|claude|dsh> [--locale <zh|en>]");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skill = resolve(root, "assets", "agent-skills", "openarch", "locales", locale);
const userRoots = {
  codex: process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
  cursor: resolve(homedir(), ".cursor"),
  opencode: resolve(homedir(), ".config", "opencode"),
  claude: resolve(homedir(), ".claude"),
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
