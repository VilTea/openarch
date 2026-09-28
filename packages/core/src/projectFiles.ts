import { existsSync, readFileSync } from "node:fs";
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

/** 只读 config.yml 里显式声明的 languages；不做指示文件检测。
 *  热路径（每个变更文件都要判定是否可分析）用它，避免重复的递归目录遍历（校准 2026-09-25）。 */
const readConfiguredLanguages = (cwd: string): readonly Language[] | undefined => {
  // D-G13：读取走 `readProjectConfig`（唯一权威）。`invalid` 时仍**回退指示文件探测**
  // ——这是项目所有者批准保留的行为（只去重、不改事实）；它的后果（"声明语言"被换成
  // "探测语言"进而改变 scope 指纹）已由 `context`（配置无法解析）与 `test`（BLOCK）两面暴露。
  const read = readProjectConfig(projectConfigPath(cwd));
  return read.status === "ok" ? parseConfiguredLanguages((read.value as { languages?: unknown } | undefined)?.languages) : undefined;
};

export const readProjectLanguages = (cwd = projectRoot()): readonly Language[] => {
  // 已声明语言时不再做指示文件检测：检测是深度受限的递归目录遍历，
  // 而它在 isAnalyzableSourceFile 这类"每个文件调一次"的热路径上被反复触发。
  const configured = readConfiguredLanguages(cwd);
  return configured && configured.length > 0 ? configured : detectProjectLanguages(cwd);
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
  const configured = readConfiguredLanguages(cwd);
  return {
    configured,
    detected: detectProjectLanguages(cwd),
    configExists: readProjectConfig(projectConfigPath(cwd)).status !== "missing",
  };
};

/**
 * config.yml 的**读取唯一权威**（D-G13，2026-09-25 项目所有者批准）。
 *
 * 缺陷：同一份文件曾有三个各自 `load(...)` + `catch` 的读者——`loadGateConfig`（抛
 * `GateConfigurationError`）、`readConfiguredLanguages`（吞掉后回退指示文件探测）、
 * `loadTestGovernanceConfiguration`（吞掉后报 `configured: false`）。三者对"读不出来"的
 * 处理各不相同，其中后两者会把**解析失败**说成"未声明语言"/"未配置"（实测：一份重复映射键的
 * `config.yml` 让 `test` 报 `test_governance_not_configured` 并报 0 个测试文件）。
 *
 * 本权威只回答**能否读**这一件事，并把三种状态分开：
 * - `missing`：文件不存在（调用方可回退到指示文件探测）；
 * - `invalid`：文件存在但读不出来（**不是**"未配置"，两者必须能分别上报）；
 * - `ok`：解析成功并给出值。
 *
 * 调用方**各自决定**语义分支（本权威不替它们决定是否回退——那是行为策略，不是读取事实）。
 * 路径由调用方给出：`status`/`loadGateConfig` 用 `configPath()`（尊重 `OPENARCH_BASE_DIR`），
 * 项目文件探测用 `<cwd>/.openarch/config.yml`。**不合并这两种解析**，否则会悄悄改变
 * 隔离运行下的行为。
 */
export type ProjectConfigRead =
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly error: string }
  | { readonly status: "ok"; readonly value: unknown };

/** 项目配置路径（唯一表达式：此前 `readConfiguredLanguages`/`configuredFileKindRules` 各写一份）。 */
export const projectConfigPath = (cwd = projectRoot()): string => join(cwd, ".openarch", "config.yml");

export const readProjectConfig = (path: string = projectConfigPath()): ProjectConfigRead => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { status: "missing" };
  }
  try {
    return { status: "ok", value: load(raw) };
  } catch (error) {
    return { status: "invalid", error: error instanceof Error ? error.message : "configuration could not be parsed" };
  }
};

/** config.yml `file_kinds` 里**项目显式声明**的分类规则（原样，不含任何推导）。 */
const configuredFileKindRules = (cwd: string): readonly FileKindRule[] => {
  const read = readProjectConfig(projectConfigPath(cwd));
  if (read.status !== "ok") return [];
  const config = read.value as { file_kinds?: unknown } | undefined;
  return Array.isArray(config?.file_kinds)
    ? config.file_kinds.filter(isFileKindRule)
    : [];
};

/**
 * 由**项目实际布局**推导的分类规则（项目无需手写）。
 *
 * 缺陷（2026-09-25 实地核实，`.research/openarch-java-junit`）：`classifyFileKind` 的默认判定
 * 只看文件名后缀（`/(?:test|tests|it)\.java$/`），于是 `src/main/java` 下的**生产**文件——
 * JUnit 自己的 `org/junit/Test.java`（注解定义）、`runners/AllTests.java`、`extensions/RepeatedTest.java`、
 * `framework/Test.java`——被算进 `test-governance` population，`testFiles=256` 里混进 4 个非测试文件。
 *
 * **为什么表达为规则而不是 `classifyFileKind` 里的分支**（契约纪律）：
 * `fileKind` 是**持久化**事实（baseline index），它决定 population 成员，而 scope fingerprint
 * （`createAnalysisScope`）只由 `languages + extensions + fileKindRules` 构成，并充当
 * gate 的 baseline 兼容判据（`baseline_scope_incompatible`）。把布局表达成规则 ⇒
 * 分类语义的变化**自动进入 scope fingerprint** ⇒ 只让真正受影响的 baseline
 * （存在 `src/test/java` 的项目）变为不兼容并提示 `scan --rebuild`；
 * 若写成默认分类器里的硬编码分支，语义变了却不进任何身份，旧 baseline 会静默保留旧 `fileKind`
 * 而 `status` 仍报 scope compatible —— 事实与身份不一致。
 *
 * 判据（Maven / Gradle / Android 通用布局）：**同时**存在 `src/main/java` 与 `src/test/java`
 * 时才推导"`src/main/java` 是生产树"。要求两者共存是保守选择：只有 `src/main/java`
 * 而无 `src/test/java` 的项目（把测试放在 main 树）不会被夺走测试身份。
 * 推导规则排在配置规则**之后**（`find` 首个匹配生效），因此项目显式声明始终优先。
 */
const layoutDerivedFileKindRules = (cwd: string): readonly FileKindRule[] => {
  const hasMain = existsSync(join(cwd, "src", "main", "java"));
  const hasTest = existsSync(join(cwd, "src", "test", "java"));
  return hasMain && hasTest ? [{ pattern: "src/main/java/**", kind: "production" }] : [];
};

/**
 * 项目分类规则的唯一入口：**配置规则在前（显式项目决策优先），布局推导规则在后**。
 * 分类与 scope fingerprint 都只消费本函数的返回值，避免"某一处忘了加推导规则"
 * 导致同一个文件在不同路径下被分成不同 kind。
 */
export const readProjectFileKindRules = (cwd = projectRoot()): readonly FileKindRule[] => [
  ...configuredFileKindRules(cwd),
  ...layoutDerivedFileKindRules(cwd),
];

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
