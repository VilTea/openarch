import { Layer } from "effect";
import { resolve } from "node:path";
import { Locale, message } from "./i18n";
import {
  AdvisoryLockAdapterLive,
  CelAdapterLive,
  JsonFileStorageLive,
  SemanticToolchainDiscoveryLive,
  ScanProgressFileLive,
  SemanticRelationServiceLive,
  SymbolUseServiceLive,
  TreeSitterParserLive,
  extensionsForLanguages,
  implicitDepsPath,
  isAnalyzableProjectFile,
  listProjectSourceFiles,
  projectRoot,
  readProjectLanguages as readConfiguredProjectLanguages,
  readImplicitDepsYml,
  toAbsolute,
  type GovernancePopulation,
} from "@openarch/core";

export interface CommandContext {
  readonly cwd: string;
  readonly rawArgv: readonly string[];
  readonly locale: Locale;
}

/** 命令可以同步完成；CLI 入口统一 await，避免为契约人为制造 async。 */
export type CommandHandler = (args: readonly string[], context: CommandContext) => number | Promise<number>;

export const LiveLayer = Layer.merge(
  Layer.merge(Layer.merge(Layer.merge(TreeSitterParserLive, JsonFileStorageLive), ScanProgressFileLive), Layer.merge(SymbolUseServiceLive.pipe(Layer.provide(SemanticToolchainDiscoveryLive)), SemanticRelationServiceLive)),
  Layer.merge(CelAdapterLive, AdvisoryLockAdapterLive),
);

/** An explicit OPENARCH_BASE_DIR is the declared boundary for isolated workspace runs. */
export const effectiveProjectRoot = (cwd: string): string => process.env.OPENARCH_BASE_DIR ? projectRoot() : cwd;

export const defaultScanPaths = (cwd: string): readonly string[] =>
  listProjectSourceFiles({ cwd: effectiveProjectRoot(cwd), population: "observed" });

const errorCauseText = (cause: unknown): string => cause instanceof Error ? cause.message : cause ? String(cause) : "";

const historyPath = (value: string): boolean => value
  .replace(/\\/g, "/")
  .split("/")
  .some((segment) => segment.toLowerCase() === "history");

/** Returns recovery guidance only for an IO failure rooted in the sealed history ledger. */
export const analysisRecoveryHint = (error: unknown, locale: Locale = "en"): string | undefined => {
  const tagged = error as { _tag?: string; path?: unknown; cause?: unknown } | null | undefined;
  if (tagged?._tag !== "IoError") return undefined;
  const path = typeof tagged.path === "string" ? tagged.path : "";
  const cause = errorCauseText(tagged.cause);
  if (!historyPath(path) && !/malformed history|history checkpoint|history compaction/i.test(cause)) return undefined;
  return message(locale, "analysis.historyRecovery");
};

export const printAnalysisError = (error: unknown, locale: Locale = "en"): void => {
  const tagged = error as { _tag?: string; path?: string; cause?: unknown; message?: string } | null | undefined;
  const tag = tagged?._tag ?? "UnknownError";
  const path = tagged?.path ? ` ${tagged.path}` : "";
  // CoordinationError carries a human-readable detail in message; prefer it over the raw cause category.
  const detail = tag === "CoordinationError" && typeof tagged?.message === "string" && tagged.message
    ? tagged.message
    : errorCauseText(tagged?.cause);
  const failure = message(locale, "analysis.failed", { tag, path, cause: detail ? `: ${detail}` : "" });
  const recovery = analysisRecoveryHint(error, locale);
  console.error(recovery ? `${failure}\n${recovery}` : failure);
};

export const readImplicitDeps = () => {
  const path = typeof implicitDepsPath === "function" ? implicitDepsPath() : ".openarch/implicit-deps.yml";

  return readImplicitDepsYml(path).map(({ from, to, via, type }) => ({
    from: toAbsolute(from),
    to: toAbsolute(to),
    via,
    type,
  }));
};

export const resolveScanExtensions = (cwd = process.cwd()): string[] => {
  const extensions = extensionsForLanguages(readConfiguredProjectLanguages(cwd));
  return extensions.length > 0 ? [...new Set(extensions)] : [];
};

/** Delegates all path/role decisions to the core participation contract. */
export const isAnalyzableSourceFile = (
  path: string,
  cwd = process.cwd(),
  population: GovernancePopulation = "observed",
): boolean => {
  const root = effectiveProjectRoot(cwd);
  return isAnalyzableProjectFile(resolve(root, path), { cwd: root, languages: readConfiguredProjectLanguages(root), population });
};

export const parseOptionValue = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

/** Collects positional values following one flag, stopping at the next option. */
export const parseOptionValues = (args: readonly string[], flag: string): readonly string[] => {
  const index = args.indexOf(flag);
  if (index < 0) return [];
  const values: string[] = [];
  for (let cursor = index + 1; cursor < args.length && !args[cursor].startsWith("--"); cursor += 1) values.push(args[cursor]);
  return values;
};
