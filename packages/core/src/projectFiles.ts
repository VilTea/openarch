import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve, isAbsolute } from "node:path";
import { load } from "js-yaml";
import type { Language } from "./domain/ast";
import { classifyFileKindWithPolicy, isFileKindRule, type FileKindRule } from "./domain/testGovernance";
import { participatesInPopulation, type GovernancePopulation } from "./domain/fileParticipation";
import { globSync } from "./infra/glob";
import { toPosixPath, projectRoot } from "./infra/paths";
import { SCAN_EXCLUDED_DIRECTORY_NAMES } from "./infra/scanExclusions";
import { detectProjectLanguages } from "./languageSupport";
import { createAnalysisScope, isPathInAnalysisScope } from "./domain/analysisScope";
import { canonicalPathKey, hasSymlinkAncestor, isWithinProjectRoot } from "./projectFilesScan";

const normalizePath = (path: string): string => toPosixPath(path).toLowerCase();

const parseConfiguredLanguages = (input: unknown): readonly Language[] | undefined =>
  Array.isArray(input) && input.every((language) => typeof language === "string")
    ? input as readonly Language[]
    : undefined;

export const readProjectLanguages = (cwd = projectRoot()): readonly Language[] => {
  const state = readProjectLanguageState(cwd);
  return state.configured && state.configured.length > 0 ? state.configured : state.detected;
};

/** 项目语言状态：区分"显式配置"与"指示文件检测"，供 hook 等场景提醒 agent
 *  配置 languages（校准 2026-08-07：已初始化但未声明语言的提醒依据）。 */
export interface ProjectLanguageState {
  /** config.yml 显式声明的 languages（未声明/非法时 undefined） */
  readonly configured?: readonly Language[];
  /** 按项目指示文件检测的语言（go.mod/pom.xml 等，不扫源码） */
  readonly detected: readonly Language[];
  /** .openarch/config.yml 是否存在（已初始化） */
  readonly configExists: boolean;
}

export const readProjectLanguageState = (cwd = projectRoot()): ProjectLanguageState => {
  let configExists = false;
  let configured: readonly Language[] | undefined;
  try {
    const raw = readFileSync(join(cwd, ".openarch", "config.yml"), "utf8");
    configExists = true;
    // js-yaml 对纯注释/空文档抛错——文件存在即视为已初始化，解析失败仅清 configured
    configured = parseConfiguredLanguages((load(raw) as { languages?: unknown } | undefined)?.languages);
  } catch {
    // 未初始化，或配置内容无法解析——回退指示文件检测
  }
  return { configured, detected: detectProjectLanguages(cwd), configExists };
};

export const readProjectFileKindRules = (cwd = projectRoot()): readonly FileKindRule[] => {
  try {
    const config = load(readFileSync(join(cwd, ".openarch", "config.yml"), "utf8")) as { file_kinds?: unknown } | undefined;
    return Array.isArray(config?.file_kinds)
      ? config.file_kinds.filter(isFileKindRule)
      : [];
  } catch { return []; }
};

export const resolveProjectExtensions = (cwd = projectRoot(), languages = readProjectLanguages(cwd)): readonly string[] => {
  return createAnalysisScope(languages).extensions;
};

export interface ProjectSourceFilesOptions {
  readonly cwd?: string;
  readonly languages?: readonly Language[];
  /** Fixed product concern; it does not add project configuration. */
  readonly population?: GovernancePopulation;
  readonly fileKindRules?: readonly FileKindRule[];
}

const populationOf = (options: Pick<ProjectSourceFilesOptions, "population">): GovernancePopulation =>
  options.population ?? "observed";

export const isAnalyzableProjectFile = (
  path: string,
  options: Pick<ProjectSourceFilesOptions, "cwd" | "languages" | "population" | "fileKindRules"> = {},
): boolean => {
  const cwd = options.cwd ?? projectRoot();
  const languages = options.languages ?? readProjectLanguages(cwd);
  const population = populationOf(options);
  const fileKindRules = options.fileKindRules ?? readProjectFileKindRules(cwd);
  if (!isWithinProjectRoot(path, cwd)) return false;
  if (!isPathInAnalysisScope(path, createAnalysisScope(languages))) return false;
  return participatesInPopulation(
    classifyFileKindWithPolicy(normalizePath(path), fileKindRules, { projectRoot: cwd }),
    population,
  );
};

export const listProjectSourceFiles = (options: ProjectSourceFilesOptions = {}): readonly string[] => {
  const cwd = options.cwd ?? projectRoot();
  const languages = options.languages ?? readProjectLanguages(cwd);
  const population = populationOf(options);
  const fileKindRules = options.fileKindRules ?? readProjectFileKindRules(cwd);
  const extensions = resolveProjectExtensions(cwd, languages);
  if (extensions.length === 0) return [];

  const seenRealPaths = new Set<string>();
  return [...new Set(
    extensions.flatMap((extension) => globSync(`**/*${extension}`, { cwd }))
      .map((path) => resolve(cwd, path))
      .sort(),
  )].filter((path) => {
    // 固定产品边界：构建/依赖目录不参与扫描；symlink 别名跳过，保留真实路径
    //（校准 2026-08-15：serde 探针发现 symlink 使 208 个真实源码被双计为 242）。
    const relativePath = relative(cwd, path).replace(/\\/g, "/").toLowerCase();
    if (relativePath.split("/").some((segment) => SCAN_EXCLUDED_DIRECTORY_NAMES.has(segment))) return false;
    if (hasSymlinkAncestor(path, cwd)) return false;
    const realKey = canonicalPathKey(path);
    if (seenRealPaths.has(realKey)) return false;
    seenRealPaths.add(realKey);
    return isAnalyzableProjectFile(path, { cwd, languages, population, fileKindRules });
  });
};

/** 逐文件内容身份（sha256）：增量扫描的变更检测基准——不依赖 git，覆盖
 *  untracked/内容变化；与 sourceSnapshotSha256 同源但保留 per-file 粒度。 */
export const contentHashesOf = (paths: readonly string[], cwd = projectRoot()): ReadonlyMap<string, string> => {
  const hashes = new Map<string, string>();
  for (const path of paths) {
    try {
      if (!isWithinProjectRoot(path, cwd)) continue;
      hashes.set(relative(cwd, path).replace(/\\/g, "/"), createHash("sha256").update(readFileSync(path)).digest("hex"));
    } catch {
      // 读取失败（删除/权限）按不存在处理——调用方据 current 集合判断删除
    }
  }
  return hashes;
};

/** Content identity for one selected source population, separate from metrics. */
export const sourceSnapshotSha256 = (paths: readonly string[], cwd = projectRoot()): string | undefined => {
  try {
    if (paths.some((path) => !isWithinProjectRoot(path, cwd))) return undefined;
    const entries = [...new Set(paths)]
      .map((path) => [relative(cwd, path).replace(/\\/g, "/"), createHash("sha256").update(readFileSync(path)).digest("hex")] as const)
      .sort(([left], [right]) => left.localeCompare(right));
    return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  } catch {
    return undefined;
  }
};

/** .openarch/config.yml 内容 hash（P2-1：配置变化时增量 scan 自动退化全量重建）。 */
export const configSnapshotSha256 = (configPath: string): string | undefined => {
  try {
    return createHash("sha256").update(readFileSync(configPath)).digest("hex");
  } catch {
    return undefined;
  }
};
