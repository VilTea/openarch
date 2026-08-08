#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const valueFor = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const target = valueFor("--target");
const requestedLocale = valueFor("--locale");
const supportedTargets = new Set(["codex", "cursor", "opencode", "claude"]);
const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh") ? "zh" : "en";
const locale = requestedLocale ?? systemLocale;

if (!target || !supportedTargets.has(target) || !["zh", "en"].includes(locale) || process.argv.includes("--scope")) {
  console.error("Usage: openarch-agent-install --target <codex|cursor|opencode|claude> [--locale <zh|en>]");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skill = resolve(root, "assets", "agent-skills", "openarch", "locales", locale);
const userRoots = {
  codex: process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
  cursor: resolve(homedir(), ".cursor"),
  opencode: resolve(homedir(), ".config", "opencode"),
  claude: resolve(homedir(), ".claude"),
};
const destinationRoot = resolve(userRoots[target], "skills");
const destination = resolve(destinationRoot, "openarch");

if (!existsSync(skill)) {
  console.error("OpenArch Skill 资产缺失，安装包可能不完整。");
  process.exit(3);
}

mkdirSync(destinationRoot, { recursive: true });
const suffix = `${process.pid}-${Date.now()}`;
const staging = resolve(destinationRoot, `.openarch-skill-staging-${suffix}`);
const backup = resolve(destinationRoot, `.openarch-skill-backup-${suffix}`);
try {
  cpSync(skill, staging, { recursive: true });
  if (existsSync(destination)) renameSync(destination, backup);
  renameSync(staging, destination);
} catch (error) {
  if (existsSync(backup) && !existsSync(destination)) renameSync(backup, destination);
  throw error;
} finally {
  rmSync(staging, { recursive: true, force: true });
  rmSync(backup, { recursive: true, force: true });
}
console.log(`Installed OpenArch Skill (${locale}): ${destination}`);
