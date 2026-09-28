import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileHidden } from "../infra/childProcess";
import { dirname, isAbsolute, resolve } from "node:path";
import { DEFAULT_HISTORY_RAW_WINDOW_DAYS } from "../domain/historyRetention";
import { atomicWriteTextIfChanged } from "../adapter/storage/AtomicWriter";
import { readProjectConfig } from "../projectFiles";

export type GovernancePersistence = "local" | "tracked";
export interface HistoryRetentionPolicy { readonly rawWindowDays: number; }
export const DEFAULT_HISTORY_RETENTION: HistoryRetentionPolicy = { rawWindowDays: DEFAULT_HISTORY_RAW_WINDOW_DAYS };

export interface GovernancePersistenceMigration {
  readonly persistence: GovernancePersistence;
  readonly configChanged: boolean;
  readonly exclude: "updated" | "unchanged" | "unavailable";
  readonly trackedPaths: readonly string[];
}

const EXCLUDE_BLOCK = "# OpenArch local persistence\n.openarch/\n";
const TOOLCHAIN_EXCLUDE_BLOCK = "# OpenArch machine-local toolchains\n.openarch/toolchains.local.yml\n";
// Full test/CI workers can briefly contend for Git process startup on Windows.
const GIT_METADATA_TIMEOUT_MS = 15_000;

const configPathFor = (cwd: string): string => resolve(cwd, ".openarch", "config.yml");

/**
 * 读取路径上的 config.yml 并返回其映射根（唯一读取权威 `readProjectConfig`）。
 *
 * 缺陷（2026-09-25 复核）：本模块此前有**第二个** `readFileSync` + `load` 读者
 * （`readGovernancePersistence` / `readHistoryRetentionPolicy` 各一次），与 `projectFiles` 的
 * 唯一权威并存。现在两者都消费权威；失败语义**逐字保留**：
 * - 文件不存在 ⇒ `"missing"`（调用方给出默认值）；
 * - 解析失败或根不是映射 ⇒ **抛错**（严格 fail-closed，`init` 会以 exit 3 报告）。
 *
 * 注意写路径**不走这里**：它必须在**原文**上做就地定位与改写（`yamlRoot(text)`），
 * 不能替换成"读到的值"——否则会把用户的注释与格式一起丢掉。
 */
const yamlRootFor = (cwd: string): Record<string, unknown> | "missing" => {
  const read = readProjectConfig(configPathFor(cwd));
  if (read.status === "missing") return "missing";
  if (read.status === "invalid") throw new Error(read.error);
  const root = read.value;
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("config root must be a mapping");
  return root as Record<string, unknown>;
};

const yamlRoot = async (text: string): Promise<Record<string, unknown>> => {
  const { load } = await import("js-yaml");
  const root = load(text);
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("config root must be a mapping");
  return root as Record<string, unknown>;
};

export const readGovernancePersistence = async (cwd: string): Promise<GovernancePersistence> => {
  const root = yamlRootFor(cwd);
  if (root === "missing") return "tracked";
  const governance = root.governance;
  if (governance === undefined) return "tracked";
  if (!governance || typeof governance !== "object" || Array.isArray(governance)) throw new Error("governance must be a mapping");
  const persistence = (governance as Record<string, unknown>).persistence;
  if (persistence === undefined) return "tracked";
  if (persistence === "local" || persistence === "tracked") return persistence;
  throw new Error("governance.persistence must be local or tracked");
};

/** Config-owned raw evidence window; checkpoint aggregation preserves CRL outside it exactly. */
export const readHistoryRetentionPolicy = async (cwd: string): Promise<HistoryRetentionPolicy> => {
  const root = yamlRootFor(cwd);
  if (root === "missing") return DEFAULT_HISTORY_RETENTION;
  const governance = root.governance;
  if (governance === undefined) return DEFAULT_HISTORY_RETENTION;
  if (!governance || typeof governance !== "object" || Array.isArray(governance)) throw new Error("governance must be a mapping");
  const history = (governance as Record<string, unknown>).history;
  if (history === undefined) return DEFAULT_HISTORY_RETENTION;
  if (!history || typeof history !== "object" || Array.isArray(history)) throw new Error("governance.history must be a mapping");
  const rawWindowDays = (history as Record<string, unknown>).raw_window_days;
  if (rawWindowDays === undefined) return DEFAULT_HISTORY_RETENTION;
  if (!Number.isInteger(rawWindowDays) || (rawWindowDays as number) < 1 || (rawWindowDays as number) > 3650) {
    throw new Error("governance.history.raw_window_days must be an integer from 1 through 3650");
  }
  return { rawWindowDays: rawWindowDays as number };
};

const indentOf = (line: string): number => (line.match(/^[ \t]*/) ?? [""])[0].length;

/** flow 形态 / 就地定位不到的 governance 映射：显式拒绝，而不是追加出重复键。 */
const GOVERNANCE_NOT_MIGRATABLE = "inline governance mapping cannot be migrated; expand it before setting persistence";

/**
 * flow 形态一律 fail-closed 不落盘，但报错必须区分"值已等于目标"与"值不同（或缺失）"：
 * 前者只需展开 flow，展开后**无需任何改动**；只给一条"不能迁移"的报错会让人以为还要改配置。
 * 这里不做等值短路（不引入新的语义分支）：两条路径都拒绝写入。
 */
const notMigratableError = (current: unknown, persistence: GovernancePersistence): Error =>
  current === persistence
    ? new Error(`flow-style governance mapping already sets persistence: ${persistence}; expand it to a block mapping and no change is required`)
    : new Error(GOVERNANCE_NOT_MIGRATABLE);

/** 顶层 `governance:` 键不存在时追加块风格映射；该分支只在 js-yaml 解析确认键不存在时可达。 */
const appendGovernanceBlock = (text: string, persistence: GovernancePersistence): string => {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const suffix = text.endsWith("\n") || text.endsWith("\r\n") ? "" : newline;
  return [text, suffix, newline, "governance:", newline, "  persistence: ", persistence, newline].join("");
};

/**
 * 在块风格 governance 映射内就地写入 `persistence`；定位不到返回 null。
 * 只做"定位"，不做"判据"：`governance` 是否存在由调用方的 js-yaml 解析结果决定，定位失败一律 fail-closed。
 * 缩进扫描而非"更聪明的正则"：块内非空行的最小缩进就是直接子键缩进（后代一定更深），
 * 因此 `governance.history.persistence` 这类更深层同名键不会被误改。
 */
const rewriteGovernanceBlock = (text: string, persistence: GovernancePersistence): string | null => {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const governanceIndex = lines.findIndex((line) => /^governance:[ \t]*(?:#.*)?$/.test(line));
  if (governanceIndex < 0) return null;
  const governanceIndent = indentOf(lines[governanceIndex]);
  let blockEnd = lines.length;
  for (let index = governanceIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim() !== "" && indentOf(lines[index]) <= governanceIndent) {
      blockEnd = index;
      break;
    }
  }
  let childIndent = Number.POSITIVE_INFINITY;
  for (let index = governanceIndex + 1; index < blockEnd; index += 1) {
    if (lines[index].trim() !== "") childIndent = Math.min(childIndent, indentOf(lines[index]));
  }
  let persistenceIndex = -1;
  if (Number.isFinite(childIndent)) {
    for (let index = governanceIndex + 1; index < blockEnd; index += 1) {
      if (indentOf(lines[index]) !== childIndent) continue;
      if (!/^[ \t]*persistence:[ \t]*[^#\r\n]*(?:[ \t]*#.*)?$/.test(lines[index])) continue;
      persistenceIndex = index;
      break;
    }
  }
  if (persistenceIndex >= 0) {
    lines[persistenceIndex] = `${" ".repeat(childIndent)}persistence: ${persistence}`;
    return lines.join(newline);
  }
  lines.splice(governanceIndex + 1, 0, `${" ".repeat(governanceIndent + 2)}persistence: ${persistence}`);
  return lines.join(newline);
};

/** 除 governance 外的顶层键值形态；用于证明改写没有动到用户的其他配置。 */
const otherTopLevelShape = (root: Record<string, unknown>): string =>
  JSON.stringify(Object.entries(root).filter(([key]) => key !== "governance").sort(([left], [right]) => (left < right ? -1 : 1)));

/**
 * 写入前的结构化验证（D7 的判据）。
 * 旧实现用 `/^governance:[ \t]*\{.*\}[ \t]*$/m` 在文本上"预测"可迁移性：该正则带 m 但不跨行，
 * 跨行 flow mapping（`governance: {` + 缩进续行）既逃过守卫、又逃过块键行定位，于是走"末尾追加"分支，
 * 生成第二个顶层 `governance:` 键；js-yaml 读回时抛 `duplicated mapping key` ⇒ 用户 config.yml 不可解析。
 * 现改为对**待写入文本**重新解析并核对不变量，任一不满足即拒绝写入（fail-closed），绝不落盘：
 *   1. 可被 js-yaml 解析（重复键与语法错误在此暴露）；
 *   2. governance 仍是映射，且 governance.persistence 已等于目标值；
 *   3. 除 governance 外的顶层键值逐值不变（证明没有动到用户的其他配置）。
 * 这是"用解析结果判断"而不是"再加一层正则"：js-yaml 是唯一的 YAML 权威，读与写不再各有一套解释。
 */
const assertPersistenceWriteSafe = async (root: Record<string, unknown>, after: string, persistence: GovernancePersistence): Promise<void> => {
  let rewritten: Record<string, unknown>;
  try {
    rewritten = await yamlRoot(after);
  } catch {
    throw new Error(GOVERNANCE_NOT_MIGRATABLE);
  }
  const governance = rewritten.governance;
  if (!governance || typeof governance !== "object" || Array.isArray(governance)) throw new Error(GOVERNANCE_NOT_MIGRATABLE);
  if ((governance as Record<string, unknown>).persistence !== persistence) throw new Error(GOVERNANCE_NOT_MIGRATABLE);
  if (otherTopLevelShape(rewritten) !== otherTopLevelShape(root)) throw new Error(GOVERNANCE_NOT_MIGRATABLE);
};

export const setGovernancePersistence = async (cwd: string, persistence: GovernancePersistence): Promise<boolean> => {
  const configPath = configPathFor(cwd);
  if (!existsSync(configPath)) throw new Error("config.yml is required before setting governance.persistence");
  const before = readFileSync(configPath, "utf8");
  // 权威判据是 js-yaml 的解析结果，不是"文本上像不像 governance: 行"：
  // 重复键在此已抛错，`root.governance` 是否存在、是否为映射也由此确定。
  const root = await yamlRoot(before);
  if (root.governance !== undefined && (!root.governance || typeof root.governance !== "object" || Array.isArray(root.governance))) {
    throw new Error("governance must be a mapping");
  }
  let after: string;
  if (root.governance === undefined) {
    after = appendGovernanceBlock(before, persistence);
  } else {
    // governance 键已存在（解析已证明）→ 只能在原块内就地改写；定位失败即 fail-closed，
    // 绝不退化成"再追加一个 governance: 键"——那会让 config.yml 变成重复键而无法被解析。
    const rewritten = rewriteGovernanceBlock(before, persistence);
    if (rewritten === null) {
      const current = (root.governance as Record<string, unknown>).persistence;
      throw notMigratableError(current, persistence);
    }
    after = rewritten;
  }
  if (after === before) return false;
  await assertPersistenceWriteSafe(root, after, persistence);
  await atomicWriteTextIfChanged(configPath, after);
  return true;
};

const gitPath = (cwd: string, args: readonly string[]): string | undefined => {
  try {
    return execFileHidden("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_METADATA_TIMEOUT_MS }).trim() || undefined;
  } catch {
    return undefined;
  }
};

const localExcludePath = (cwd: string): string | undefined => {
  const path = gitPath(cwd, ["rev-parse", "--git-path", "info/exclude"]);
  return path ? isAbsolute(path) ? path : resolve(cwd, path) : undefined;
};

const removeManagedExclude = (text: string): string =>
  text.replace(/\r?\n?# OpenArch local persistence\r?\n\.openarch\/\r?\n?/g, "\n");

const trackedOpenArchPaths = (cwd: string): readonly string[] =>
  (gitPath(cwd, ["ls-files", "-z", "--", ".openarch"]) ?? "").split("\0").filter(Boolean);

/** Updates only the OpenArch-owned local exclude block; user ignore rules are untouched. */
export const syncGovernancePersistence = async (cwd: string, persistence: GovernancePersistence): Promise<GovernancePersistenceMigration> => {
  const configChanged = await setGovernancePersistence(cwd, persistence);
  const excludePath = localExcludePath(cwd);
  if (!excludePath) return { persistence, configChanged, exclude: "unavailable", trackedPaths: [] };
  mkdirSync(dirname(excludePath), { recursive: true });
  const before = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const withoutManaged = removeManagedExclude(before);
  const normalized = withoutManaged.length > 0 && !withoutManaged.endsWith("\n") ? withoutManaged + "\n" : withoutManaged;
  const after = persistence === "local" ? normalized + EXCLUDE_BLOCK : normalized;
  if (after !== before) await atomicWriteTextIfChanged(excludePath, after);
  return {
    persistence,
    configChanged,
    exclude: after === before ? "unchanged" : "updated",
    trackedPaths: persistence === "local" ? trackedOpenArchPaths(cwd) : [],
  };
};

/** Keeps machine-specific executable paths out of Git without changing shared ignore policy. */
export const ensureToolchainConfigExcluded = async (cwd: string): Promise<"updated" | "unchanged" | "unavailable"> => {
  const excludePath = localExcludePath(cwd);
  if (!excludePath) return "unavailable";
  mkdirSync(dirname(excludePath), { recursive: true });
  const before = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (before.includes(TOOLCHAIN_EXCLUDE_BLOCK)) return "unchanged";
  const normalized = before.length > 0 && !before.endsWith("\n") ? before + "\n" : before;
  await atomicWriteTextIfChanged(excludePath, normalized + TOOLCHAIN_EXCLUDE_BLOCK);
  return "updated";
};
