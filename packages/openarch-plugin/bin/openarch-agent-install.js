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
const installPreset = process.argv.includes("--preset");
const supportedTargets = new Set(["codex", "cursor", "opencode", "claude", "dsh"]);
const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh") ? "zh" : "en";
const locale = requestedLocale ?? systemLocale;

if (!target || !supportedTargets.has(target) || !["zh", "en"].includes(locale) || process.argv.includes("--scope") || (installPreset && target !== "dsh")) {
  console.error("Usage: openarch-agent-install --target <codex|cursor|opencode|claude|dsh> [--locale <zh|en>] [--preset]");
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

if (installPreset) {
  const presetSource = resolve(root, "assets", "dsh-preset");
  const presetDestination = resolve(userRoots.dsh, ".agent-presets", "openarch");
  if (!existsSync(resolve(presetSource, "agent.cordis.yml")) || !existsSync(resolve(presetSource, "preset.yml"))) {
    console.error("OpenArch DSH preset 资产缺失，安装包可能不完整。");
    process.exit(3);
  }
  const dshSource = resolve(root, "dsh");
  const parent = dirname(presetDestination);
  mkdirSync(parent, { recursive: true });
  recoverBackup(presetDestination, ".openarch-preset-backup-");
  const suffix = `${process.pid}-${Date.now()}`;
  const staging = resolve(parent, `.openarch-preset-staging-${suffix}`);
  const backup = resolve(parent, `.openarch-preset-backup-${suffix}`);
  try {
    cpSync(presetSource, staging, { recursive: true });
    cpSync(resolve(root, "skills", "openarch-zh"), resolve(staging, "skills", "openarch-zh"), { recursive: true });
    cpSync(resolve(root, "skills", "openarch-en"), resolve(staging, "skills", "openarch-en"), { recursive: true });
    // DSH 插件源码（host/client 模块 + 测试 + 文档）随预设一起安装；
    // agent.cordis.yml 以 ./dsh/host/*.mjs 相对路径引用它们。
    if (existsSync(dshSource)) {
      cpSync(dshSource, resolve(staging, "dsh"), { recursive: true });
    }
    if (existsSync(presetDestination)) renameSync(presetDestination, backup);
    renameSync(staging, presetDestination);
  } catch (error) {
    if (existsSync(backup) && !existsSync(presetDestination)) renameSync(backup, presetDestination);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
  }
  console.log(`Installed OpenArch DSH preset: ${presetDestination}`);
}
