import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultScriptAssets } from "../script-runtime/defaultScriptAssets";
import { runtimeResourcePath } from "../runtimeAssets";

const manifest = () => defaultScriptAssets();
const templateRoot = runtimeResourcePath("assets", "templates");

/** Project-relative target for a packaged script asset, when it has one. */
export const defaultScriptTarget = (id: string): string | undefined =>
  manifest().find((entry) => entry.id === id && entry.kind === "script")?.target;

export interface DefaultScriptInstallResult {
  readonly installed: string[];
  readonly replaced: string[];
  readonly unchanged: string[];
  readonly errors: string[];
}

export const defaultScriptIdForPath = (path: string): string | undefined => {
  const normalized = path.replace(/\\/g, "/");
  return manifest().find((entry) => entry.kind === "script" && entry.target && normalized.endsWith(`/${entry.target}`))?.id;
};

/** Explicit replacement is the only migration path for an already-installed default asset. */
export const installDefaultScripts = (
  cwd: string,
  languages: readonly string[],
  ids: readonly string[],
  options: { readonly replace?: boolean } = {},
): DefaultScriptInstallResult => {
  const installed: string[] = [], replaced: string[] = [], unchanged: string[] = [], errors: string[] = [];
  for (const id of ids) {
    const entry = manifest().find(candidate => candidate.id === id);
    if (!entry) { errors.push(`未知默认脚本: ${id}`); continue; }
    if (entry.kind === "starter") { errors.push(`${id}: starter 仅由 rules skeleton 输出，不可直接安装`); continue; }
    if (entry.kind !== "script" || !entry.source || !entry.target) { errors.push(`${id}: ${entry.kind} 需由 Agent 配置参数或启用 provider，不可直接安装`); continue; }
    if (!entry.languages || (!entry.languages.includes("*") && !entry.languages.some(language => languages.includes(language)))) { errors.push(`${id}: 与项目 languages 不匹配`); continue; }
    const target = join(cwd, entry.target);
    if (existsSync(target)) {
      if (!options.replace) { unchanged.push(id); continue; }
      cpSync(join(templateRoot, entry.source), target);
      replaced.push(id);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(templateRoot, entry.source), target);
    installed.push(id);
  }
  return { installed, replaced, unchanged, errors };
};
