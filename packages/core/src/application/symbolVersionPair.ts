import { createHash } from "node:crypto";
import { execFileHidden } from "../infra/childProcess";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { Effect } from "effect";
import ts from "typescript";
import { collectGitRevisionChangeSet } from "./changeSet";
import { readGitBlobs } from "./gitBlobBatch";
import { commonSymbolVersionedPopulation, pairVersionedSymbolDeclarations, type SymbolRevisionSnapshot, type SymbolVersionPairReport } from "../domain/symbolVersionPair";
import type { Language } from "../domain/ast";
import { isAnalyzableProjectFile, readProjectFileKindRules, readProjectLanguages } from "../projectFiles";
import { SymbolUseService } from "../port/SymbolUseService";
import { collectTypeScriptSymbolUse } from "../symbol-use/typescriptCollection";
import { isTypeScriptRevisionConfig, symbolRevisionSupportPaths } from "../symbol-use/revisionSupport";
import type { SymbolUseReport } from "../symbol-use/types";

const git = (cwd: string, args: readonly string[]): string =>
  execFileHidden("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000, maxBuffer: 64 * 1024 * 1024 });

const gitPaths = (cwd: string, revision: string): readonly string[] =>
  git(cwd, ["ls-tree", "-r", "-z", "--name-only", revision]).split("\0").filter(Boolean).sort();

const relativeExtendedConfigPath = (configPath: string, text: string, paths: ReadonlySet<string>): string | undefined => {
  const extended = ts.parseConfigFileTextToJson(configPath, text).config?.extends;
  if (typeof extended !== "string" || !extended.startsWith(".")) return undefined;
  const relative = posix.normalize(posix.join(posix.dirname(configPath), extended));
  if (relative.startsWith("../")) return undefined;
  return paths.has(relative) ? relative : paths.has(`${relative}.json`) ? `${relative}.json` : undefined;
};

const readSnapshotSupportTexts = (
  cwd: string,
  revision: string,
  paths: readonly string[],
  initialSupport: readonly string[],
): ReadonlyMap<string, import("./gitBlobBatch").SourceText> => {
  const knownPaths = new Set(paths);
  const support = new Set(initialSupport);
  const blobs = new Map(readGitBlobs(cwd, initialSupport.map((path) => ({ key: path, object: `${revision}:${path}` }))));
  let pending = initialSupport.filter(isTypeScriptRevisionConfig);
  while (pending.length > 0) {
    const additions = pending.flatMap((configPath) => {
      const text = blobs.get(configPath)?.text;
      const extendedPath = text && relativeExtendedConfigPath(configPath, text, knownPaths);
      return !extendedPath || support.has(extendedPath) ? [] : [extendedPath];
    });
    if (additions.length === 0) break;
    for (const path of additions) support.add(path);
    const extended = readGitBlobs(cwd, additions.map((path) => ({ key: path, object: `${revision}:${path}` })));
    for (const [path, value] of extended) blobs.set(path, value);
    pending = additions;
  }
  return blobs;
};

const fingerprint = (revision: string, files: readonly string[], texts: ReadonlyMap<string, string>): string =>
  createHash("sha256").update(JSON.stringify({
    definition: "symbol-revision-snapshot", revision,
    files: files.map((path) => [path, createHash("sha256").update(texts.get(path) ?? "").digest("hex")]),
  })).digest("hex");

/** Reads one revision as source evidence without changing the caller's worktree or Git index. */
export const collectSymbolRevisionSnapshot = (
  cwd: string,
  revision: string,
  languages: readonly Language[] = readProjectLanguages(cwd),
): SymbolRevisionSnapshot => {
  try {
    const resolvedRevision = git(cwd, ["rev-parse", revision]).trim();
    const fileKindRules = readProjectFileKindRules(cwd);
    const paths = gitPaths(cwd, resolvedRevision);
    const files = paths.filter((path) => isAnalyzableProjectFile(resolve(cwd, path), {
      cwd, languages, fileKindRules, population: "production-governance",
    }));
    const initialSupport = symbolRevisionSupportPaths(languages, paths);
    const supportBlobs = readSnapshotSupportTexts(cwd, resolvedRevision, paths, initialSupport);
    const support = [...supportBlobs.keys()].sort();
    const sourceBlobs = readGitBlobs(cwd, files.map((path) => ({ key: path, object: `${resolvedRevision}:${path}` })));
    const blobs = new Map([...supportBlobs, ...sourceBlobs]);
    const requested = [...new Set([...files, ...support])].map((path) => ({ key: path, object: `${resolvedRevision}:${path}` }));
    const missing = requested.filter(({ key }) => blobs.get(key)?.omitted || blobs.get(key)?.text === undefined).map(({ key }) => key);
    const texts = new Map(files.flatMap((path) => {
      const text = blobs.get(path)?.text;
      return text === undefined ? [] : [[path, text] as const];
    }));
    const supportTexts = new Map(support.flatMap((path) => {
      const text = blobs.get(path)?.text;
      return text === undefined ? [] : [[path, text] as const];
    }));
    const availability = missing.length === 0 ? "available" as const : "partial" as const;
    return {
      revision: resolvedRevision, origin: "git", availability,
      population: { files, fingerprint: fingerprint(resolvedRevision, files, texts) }, texts, supportTexts,
      ...(missing.length > 0 ? { reason: `version snapshot omitted ${missing.length} required source/config blob(s)` } : {}),
    };
  } catch (error) {
    return {
      revision, origin: "git", availability: "unavailable", population: { files: [], fingerprint: "unavailable" },
      texts: new Map(), supportTexts: new Map(), reason: error instanceof Error ? error.message : String(error),
    };
  }
};

const materializeSnapshot = (snapshot: SymbolRevisionSnapshot): string => {
  const root = mkdtempSync(join(tmpdir(), "openarch-symbol-snapshot-"));
  for (const [path, text] of [...snapshot.supportTexts, ...snapshot.texts]) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }
  return root;
};

const removeMaterializedSnapshot = (cwd: string): Promise<void> => new Promise<void>((resolve, reject) => {
  let attempts = 0;
  const remove = () => {
    try {
      rmSync(cwd, { recursive: true, force: true });
      resolve();
    } catch (error) {
      attempts += 1;
      const code = (error as NodeJS.ErrnoException).code;
      if (attempts >= 24 || (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY")) {
        reject(error);
        return;
      }
      setTimeout(remove, 250);
    }
  };
  setTimeout(remove, 500);
});

const withMaterializedSnapshot = <A, E, R>(
  snapshot: SymbolRevisionSnapshot,
  use: (cwd: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => Effect.acquireUseRelease(
  Effect.sync(() => materializeSnapshot(snapshot)),
  use,
  // Windows can retain an LSP child handle after `exit`. Keep cleanup bounded,
  // but retry asynchronously so provider shutdown is not blocked by a sync
  // sleep and a transient lock cannot turn a valid report into unavailable.
  (cwd) => Effect.promise(() => removeMaterializedSnapshot(cwd)),
);

const collectSnapshotTypeScriptReport = (snapshot: SymbolRevisionSnapshot, language: "typescript" | "javascript"): SymbolUseReport | undefined => {
  if (snapshot.availability !== "available") return undefined;
  const root = materializeSnapshot(snapshot);
  try {
    const report = collectTypeScriptSymbolUse(root, language);
    // Snapshot-relative paths are equivalent to repository-relative paths by construction.
    return report;
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 2 });
  }
};

const changedPathsFor = (cwd: string, revision: string): { readonly before: ReadonlySet<string>; readonly after: ReadonlySet<string> } => {
  const changeSet = collectGitRevisionChangeSet(cwd, revision);
  if (changeSet.availability === "unavailable") return { before: new Set(), after: new Set() };
  return {
    before: new Set(changeSet.files.map((file) => file.beforePath ?? file.path)),
    after: new Set(changeSet.files.map((file) => file.path)),
  };
};

type PreparedRevisionPair = {
  readonly _tag: "prepared";
  readonly before: SymbolRevisionSnapshot;
  readonly after: SymbolRevisionSnapshot;
  readonly population: ReturnType<typeof commonSymbolVersionedPopulation>;
};

const prepareRevisionPair = (
  cwd: string,
  revision: string,
  language: Language,
): PreparedRevisionPair | SymbolVersionPairReport => {
  const after = collectSymbolRevisionSnapshot(cwd, revision, [language]);
  let beforeRevision: string;
  try { beforeRevision = git(cwd, ["rev-parse", `${after.revision}^`]).trim(); }
  catch {
    return {
      language, availability: "unavailable",
      population: commonSymbolVersionedPopulation("unavailable", [], after.revision, after.population.files), declarations: [],
      reason: "version-pair evidence requires a Git parent revision",
    };
  }
  const before = collectSymbolRevisionSnapshot(cwd, beforeRevision, [language]);
  const population = commonSymbolVersionedPopulation(before.revision, before.population.files, after.revision, after.population.files);
  if (before.availability !== "available" || after.availability !== "available") {
    return {
      language, availability: "partial", population, declarations: [],
      reason: before.reason ?? after.reason ?? "version snapshot is incomplete",
    };
  }
  return { _tag: "prepared", before, after, population };
};

const isPreparedRevisionPair = (value: PreparedRevisionPair | SymbolVersionPairReport): value is PreparedRevisionPair =>
  "_tag" in value && value._tag === "prepared";

/**
 * First calibrated version-pair implementation. External LSPs intentionally
 * remain outside this path: a worktree LSP response is not historical Git fact.
 */
export const collectTypeScriptSymbolVersionPair = (
  cwd: string,
  revision = "HEAD",
  language: "typescript" | "javascript" = "typescript",
): SymbolVersionPairReport => {
  const prepared = prepareRevisionPair(cwd, revision, language);
  if (!isPreparedRevisionPair(prepared)) return prepared;
  const beforeReport = collectSnapshotTypeScriptReport(prepared.before, language);
  const afterReport = collectSnapshotTypeScriptReport(prepared.after, language);
  if (!beforeReport || !afterReport || beforeReport.state.availability !== "available" || afterReport.state.availability !== "available") {
    return {
      language, availability: "partial", population: prepared.population, before: beforeReport, after: afterReport, declarations: [],
      reason: beforeReport?.state.reason ?? afterReport?.state.reason ?? "compiler could not evaluate a complete version snapshot",
    };
  }
  const changed = changedPathsFor(cwd, prepared.after.revision);
  return {
    language, availability: "available", population: prepared.population, before: beforeReport, after: afterReport,
    declarations: pairVersionedSymbolDeclarations(
      beforeReport.facts.filter((fact) => changed.before.has(fact.declaration.file)),
      afterReport.facts.filter((fact) => changed.after.has(fact.declaration.file)),
    ),
  };
};

/**
 * Version pairing has a provider-specific feasibility boundary. This entry
 * makes the current LSP limitation observable to callers instead of letting
 * them substitute current-worktree references for Git-revision evidence.
 */
export const collectSymbolVersionPair = (
  cwd: string,
  revision: string,
  language: Language,
): SymbolVersionPairReport => {
  if (language === "typescript" || language === "javascript") {
    return collectTypeScriptSymbolVersionPair(cwd, revision, language);
  }
  const after = collectSymbolRevisionSnapshot(cwd, revision, [language]);
  let beforeRevision: string;
  try { beforeRevision = git(cwd, ["rev-parse", `${after.revision}^`]).trim(); }
  catch {
    return {
      language, availability: "unavailable",
      population: commonSymbolVersionedPopulation("unavailable", [], after.revision, after.population.files), declarations: [],
      reason: "version-pair evidence requires a Git parent revision",
    };
  }
  const before = collectSymbolRevisionSnapshot(cwd, beforeRevision, [language]);
  return {
    language, availability: "unavailable",
    population: commonSymbolVersionedPopulation(before.revision, before.population.files, after.revision, after.population.files), declarations: [],
    reason: `${language} historical symbol snapshots are unavailable: the current LSP provider analyzes a worktree, not bounded Git revision source`,
  };
};

/**
 * Runs an existing external semantic provider against two controlled revision
 * workspaces. The provider's own availability and coverage remain intact; a
 * materialized Git snapshot never becomes an implicit claim of completeness.
 */
export const collectLspSymbolVersionPair = (
  cwd: string,
  revision: string,
  language: Exclude<Language, "typescript" | "javascript">,
) => Effect.gen(function* () {
  const prepared = prepareRevisionPair(cwd, revision, language);
  if (!isPreparedRevisionPair(prepared)) return prepared;
  const service = yield* SymbolUseService;
  const collect = (snapshot: SymbolRevisionSnapshot) => withMaterializedSnapshot(snapshot, (snapshotCwd) =>
    service.collect({ cwd: snapshotCwd, languages: [language] }).pipe(
      Effect.map((reports) => reports.find((report) => report.origin.language === language)),
    ));
  const beforeReport = yield* collect(prepared.before);
  const afterReport = yield* collect(prepared.after);
  if (!beforeReport || !afterReport || beforeReport.state.availability === "unavailable" || afterReport.state.availability === "unavailable") {
    return {
      language, availability: "unavailable", population: prepared.population,
      before: beforeReport, after: afterReport, declarations: [],
      reason: beforeReport?.state.reason ?? afterReport?.state.reason ?? "revision workspace provider produced no language report",
    } satisfies SymbolVersionPairReport;
  }
  const changed = changedPathsFor(cwd, prepared.after.revision);
  return {
    language,
    availability: beforeReport.state.availability === "available" && afterReport.state.availability === "available" ? "available" : "partial",
    population: prepared.population, before: beforeReport, after: afterReport,
    declarations: pairVersionedSymbolDeclarations(
      beforeReport.facts.filter((fact) => changed.before.has(fact.declaration.file)),
      afterReport.facts.filter((fact) => changed.after.has(fact.declaration.file)),
    ),
  } satisfies SymbolVersionPairReport;
});
