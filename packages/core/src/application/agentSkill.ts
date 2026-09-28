import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { projectConfigPath, readProjectConfig } from "../projectFiles";
import { runtimeResourcePath } from "../runtimeAssets";

export const AGENT_SKILL_TARGETS = ["claude", "codex", "cursor", "opencode", "reasonix", "dsh"] as const;
export type AgentSkillTarget = typeof AGENT_SKILL_TARGETS[number];
export type AgentSkillLocale = "zh" | "en";

const targetRoots: Record<AgentSkillTarget, string> = {
  claude: ".claude/skills",
  codex: ".codex/skills",
  cursor: ".cursor/skills",
  opencode: ".opencode/skills",
  reasonix: ".reasonix/skills",
  dsh: ".dsh/skills",
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

/**
 * 项目期望的 Skill 语言。读取走 `readProjectConfig`（config.yml 的唯一读取权威）。
 *
 * 缺陷（2026-09-25 复核发现，与 D-G12 同类）：这里此前自己 `load(...)` + `catch { return "en" }`，
 * 于是**「config.yml 存在但读不出来」与「项目没有配置」被说成同一句话** —— 一个声明了
 * `presentation.locale: zh` 但 YAML 写坏的仓库，会被静默装上英文 Skill，且报告只显示 `en`。
 * 现在三种情况分开：不存在 ⇒ 英文（未初始化项目的默认值）；读不出来 ⇒ **返回错误**（不猜语言、
 * 不落盘）；读出来 ⇒ 按 `presentation.locale` 取值，非 `zh` 一律英文（这是**已声明并测试过**的
 * 确定性策略：只有 zh/en 两棵资产树，`fr` 之类的值明确按英文处理，不是解析失败的兜底）。
 */
const projectSkillLocale = (cwd: string): AgentSkillLocale | { readonly error: string } => {
  const path = projectConfigPath(cwd);
  const read = readProjectConfig(path);
  if (read.status === "missing") return "en";
  if (read.status === "invalid") return { error: `无法读取 ${path}：${read.error}` };
  const value = (read.value as { presentation?: { locale?: unknown } } | undefined)?.presentation?.locale;
  return value === "zh" ? "zh" : "en";
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
  const selected = input.locale ?? projectSkillLocale(input.cwd);
  // 配置读不出来时**不落盘任何东西**（fail-closed）：猜一个语言装下去，
  // 报告就再也说不清"装的是不是项目要的那棵资产树"。
  if (typeof selected !== "string") return { error: selected.error };
  const locale = selected;
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
