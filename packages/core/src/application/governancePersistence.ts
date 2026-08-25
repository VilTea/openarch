import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileHidden } from "../infra/childProcess";
import { dirname, isAbsolute, resolve } from "node:path";
import { DEFAULT_HISTORY_RAW_WINDOW_DAYS } from "../domain/historyRetention";
import { atomicWriteTextIfChanged } from "../adapter/storage/AtomicWriter";

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

const yamlRoot = async (text: string): Promise<Record<string, unknown>> => {
  const { load } = await import("js-yaml");
  const root = load(text);
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("config root must be a mapping");
  return root as Record<string, unknown>;
};

export const readGovernancePersistence = async (cwd: string): Promise<GovernancePersistence> => {
  const configPath = configPathFor(cwd);
  if (!existsSync(configPath)) return "tracked";
  const root = await yamlRoot(readFileSync(configPath, "utf8"));
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
  const configPath = configPathFor(cwd);
  if (!existsSync(configPath)) return DEFAULT_HISTORY_RETENTION;
  const root = await yamlRoot(readFileSync(configPath, "utf8"));
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

const updatePersistenceText = (text: string, persistence: GovernancePersistence): string => {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const governanceIndex = lines.findIndex((line) => /^governance:[ \t]*(?:#.*)?$/.test(line));
  if (governanceIndex < 0) {
    const suffix = text.endsWith("\n") || text.endsWith("\r\n") ? "" : newline;
    return [text, suffix, newline, "governance:", newline, "  persistence: ", persistence, newline].join("");
  }
  const governanceIndent = (lines[governanceIndex].match(/^[ \t]*/) ?? [""])[0].length;
  for (let index = governanceIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== "" && (line.match(/^[ \t]*/) ?? [""])[0].length <= governanceIndent) break;
    const match = line.match(/^([ \t]+)persistence:[ \t]*[^#\r\n]*(?:[ \t]*#.*)?$/);
    if (match && match[1].length > governanceIndent) {
      lines[index] = `${match[1]}persistence: ${persistence}`;
      return lines.join(newline);
    }
  }
  lines.splice(governanceIndex + 1, 0, `${" ".repeat(governanceIndent + 2)}persistence: ${persistence}`);
  return lines.join(newline);
};

export const setGovernancePersistence = async (cwd: string, persistence: GovernancePersistence): Promise<boolean> => {
  const configPath = configPathFor(cwd);
  if (!existsSync(configPath)) throw new Error("config.yml is required before setting governance.persistence");
  const before = readFileSync(configPath, "utf8");
  const root = await yamlRoot(before);
  if (root.governance !== undefined && (!root.governance || typeof root.governance !== "object" || Array.isArray(root.governance))) {
    throw new Error("governance must be a mapping");
  }
  if (/^governance:[ \t]*\{.*\}[ \t]*$/m.test(before)) {
    throw new Error("inline governance mapping cannot be migrated; expand it before setting persistence");
  }
  const after = updatePersistenceText(before, persistence);
  if (after === before) return false;
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
