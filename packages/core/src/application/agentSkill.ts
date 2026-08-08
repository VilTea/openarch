import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { load } from "js-yaml";
import { runtimeResourcePath } from "../runtimeAssets";

export const AGENT_SKILL_TARGETS = ["claude", "codex", "cursor", "opencode", "reasonix"] as const;
export type AgentSkillTarget = typeof AGENT_SKILL_TARGETS[number];
export type AgentSkillLocale = "zh" | "en";

const targetRoots: Record<AgentSkillTarget, string> = {
  claude: ".claude/skills",
  codex: ".codex/skills",
  cursor: ".cursor/skills",
  opencode: ".opencode/skills",
  reasonix: ".reasonix/skills",
};

export interface AgentSkillInstallInput {
  readonly cwd: string;
  readonly target?: AgentSkillTarget;
  /** Project-relative parent directory for an agent's skills. */
  readonly skillDir?: string;
  /** Optional explicit override; otherwise presentation.locale selects the Skill tree. */
  readonly locale?: AgentSkillLocale;
}

export type AgentSkillInstallResult =
  | { readonly destination: string; readonly action: "installed" | "updated"; readonly locale: AgentSkillLocale }
  | { readonly error: string };

const isWithinProject = (cwd: string, candidate: string): boolean => {
  const path = relative(resolve(cwd), candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..\\`) && !path.startsWith("../") && !isAbsolute(path);
};

const projectSkillLocale = (cwd: string): AgentSkillLocale => {
  const config = resolve(cwd, ".openarch", "config.yml");
  if (!existsSync(config)) return "en";
  try {
    const value = (load(readFileSync(config, "utf8")) as { presentation?: { locale?: unknown } } | undefined)?.presentation?.locale;
    return value === "zh" ? "zh" : "en";
  } catch { return "en"; }
};

const replaceSkillDirectory = (source: string, destination: string, parent: string): void => {
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

/** Installs the packaged public Skill into one explicit project-local agent directory. */
export const installAgentSkill = (input: AgentSkillInstallInput): AgentSkillInstallResult => {
  if (input.target && input.skillDir) return { error: "--agent 与 --skill-dir 不能同时使用" };
  if (!input.target && !input.skillDir) return { error: "需要指定 --agent 或 --skill-dir" };
  const parent = input.target ? resolve(input.cwd, targetRoots[input.target]) : resolve(input.cwd, input.skillDir!);
  if (input.skillDir && (isAbsolute(input.skillDir) || !isWithinProject(input.cwd, parent))) {
    return { error: "--skill-dir 必须是当前项目内的相对 skills 目录" };
  }
  const locale = input.locale ?? projectSkillLocale(input.cwd);
  const source = runtimeResourcePath("assets", "agent-skills", "openarch", "locales", locale);
  if (!existsSync(source)) return { error: "OpenArch Skill 资产缺失，当前发行包不完整" };
  const destination = resolve(parent, "openarch");
  const action = existsSync(destination) ? "updated" as const : "installed" as const;
  mkdirSync(parent, { recursive: true });
  try {
    replaceSkillDirectory(source, destination, parent);
    return { destination, action, locale };
  } catch {
    return { error: "OpenArch Skill 安装失败，未能原子替换目标目录" };
  }
};
