import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  checkDocuments, documentStoreObservability, MACHINE_CONTRACT_VERSIONS, readDocumentDispositions, recordDocumentDisposition,
  resolveDocumentStores, unresolvedSimilarityCandidates, type DocumentCheckReport, type DocumentStore,
} from "@openarch/core";
import { CommandHandler, parseOptionValue, parseOptionValues } from "../runtime";
import { message } from "../i18n";
import { recordCommand } from "./record";
import { statusCommand } from "./status";

const gitPaths = (gitRoot: string, staged: boolean): readonly string[] => {
  try {
    const command = staged ? "git diff --cached --name-only --diff-filter=ACM" : "git diff --name-only --diff-filter=ACM";
    return execSync(command, { cwd: gitRoot, encoding: "utf8", timeout: 5000 }).split(/\r?\n/).map((path) => path.trim()).filter((path) => path.toLowerCase().endsWith(".md"));
  } catch {
    return [];
  }
};

const stagedContent = (gitRoot: string, paths: readonly string[]): ReadonlyMap<string, string> => {
  const content = new Map<string, string>();
  for (const path of paths) {
    const repositoryPath = relative(gitRoot, path).replace(/\\/g, "/");
    if (!repositoryPath || repositoryPath.startsWith("../")) continue;
    try {
      content.set(resolve(gitRoot, path), execFileSync("git", ["show", `:${repositoryPath}`], { cwd: gitRoot, encoding: "utf8", timeout: 5000 }));
    } catch { /* deleted or not staged */ }
  }
  return content;
};

/** Explicit paths may come from the document Git root (hook context) or from a
 *  bound project cwd (record output). Existing scope-relative paths resolve
 *  against the scope first; git-root-relative paths fall back to the git root. */
const explicitAbsolutePaths = (store: DocumentStore, paths: readonly string[]): readonly string[] =>
  paths.map((path) => {
    if (isAbsolute(path)) return path;
    const scopeCandidate = resolve(store.scopeRoot, path);
    if (existsSync(scopeCandidate)) return scopeCandidate;
    return resolve(store.gitRoot, path);
  });

const storeRelativePath = (store: DocumentStore, path: string): string | undefined => {
  const value = relative(store.scopeRoot, path).replace(/\\/g, "/");
  return value && !value.startsWith("../") ? value : undefined;
};

const jsonReport = (stores: readonly DocumentStore[], reports: readonly DocumentCheckReport[]): void => {
  console.log(JSON.stringify({
    schema: MACHINE_CONTRACT_VERSIONS.docsCheckJson,
    stores: reports.map((report, index) => {
      const store = stores[index]!;
      return {
        scopeId: report.scopeId,
        scopeRoot: store.scopeRoot,
        availability: report.availability,
        ...(report.reason ? { reason: report.reason } : {}),
        indexed: report.indexed,
        updated: report.updated,
        unfilled: report.unfilled,
        candidates: report.candidates,
        openCandidates: unresolvedSimilarityCandidates(store).length,
        resolvedDispositions: readDocumentDispositions(store).length,
      };
    }),
  }, null, 2));
};

const print = (result: DocumentCheckReport, root: string, locale: "zh" | "en"): void => {
  console.log(message(locale, "docs.heading"));
  console.log(message(locale, "docs.scope", { scope: result.scopeId }));
  console.log(message(locale, "docs.root", { root }));
  if (result.availability === "unavailable") {
    console.log(message(locale, "docs.unavailable", { reason: result.reason ?? "unavailable" }));
    return;
  }
  console.log(message(locale, "docs.indexed", { indexed: result.indexed, updated: result.updated }));
  if (result.unfilled.length > 0) {
    console.log(message(locale, "docs.unfilled", { count: result.unfilled.length }));
    for (const path of result.unfilled) console.log(message(locale, "docs.unfilledEntry", { path }));
  }
  if (result.candidates.length === 0) {
    console.log(message(locale, "docs.noCandidates"));
    return;
  }
  console.log(message(locale, "docs.candidates", { count: result.candidates.length }));
  for (const candidate of result.candidates) {
    console.log(message(locale, "docs.candidate", { left: candidate.left, right: candidate.right, minhash: candidate.minHashSimilarity.toFixed(2), distance: candidate.simHashDistance }));
  }
};

const docsStatus = (stores: readonly DocumentStore[], locale: "zh" | "en"): number => {
  for (const store of stores) {
    const view = documentStoreObservability(store);
    console.log(message(locale, "docs.statusHeading", { scope: view.scopeId }));
    console.log(message(locale, "docs.statusScope", { root: view.scopeRoot, mode: view.mode }));
    console.log(message(locale, "docs.statusIndexed", { indexed: view.indexed }));
    console.log(message(locale, "docs.statusUnfilled", { count: view.unfilled.length }));
    if (view.unfilled.length > 0) {
      for (const path of view.unfilled) console.log(message(locale, "docs.unfilledEntry", { path }));
    }
    console.log(message(locale, "docs.statusCandidates", { count: view.openCandidates }));
    console.log(message(locale, "docs.statusLastCheck", { at: view.lastSimilarityCheckAt ?? message(locale, "docs.statusNever") }));
  }
  return 0;
};

const docsDecide = (args: readonly string[], stores: readonly DocumentStore[], locale: "zh" | "en"): number => {
  const store = stores[0];
  if (!store) {
    console.error(message(locale, "docs.storeMissing"));
    return 3;
  }
  const left = parseOptionValue([...args], "--left");
  const right = parseOptionValue([...args], "--right");
  const decision = parseOptionValue([...args], "--decision");
  const note = parseOptionValue([...args], "--note");
  if (!left || !right || !decision) {
    console.error(message(locale, "docs.decideUsage"));
    return 3;
  }
  const [leftAbsolute, rightAbsolute] = explicitAbsolutePaths(store, [left, right]);
  const leftRelative = storeRelativePath(store, leftAbsolute);
  const rightRelative = storeRelativePath(store, rightAbsolute);
  if (!leftRelative || !rightRelative) {
    console.error(message(locale, "docs.decideOutsideScope"));
    return 3;
  }
  const outcome = recordDocumentDisposition(store, {
    left: leftRelative, right: rightRelative,
    decision: decision as "merged" | "related" | "kept-separate",
    ...(note ? { note } : {}),
  });
  if ("error" in outcome) {
    console.error(outcome.error);
    return 3;
  }
  console.log(message(locale, outcome.replaced ? "docs.decideUpdated" : "docs.decideRecorded", { path: outcome.path }));
  return 0;
};

export const docsCommand: CommandHandler = (args, context) => {
  const locale = context.locale;
  const [action, ...rest] = args;
  const stores = resolveDocumentStores(context.cwd);
  if (action === "record") return recordCommand(rest, context);
  if (action === "status") {
    if (rest.includes("--verify")) return statusCommand(rest, context);
    if (stores.length === 0) {
      console.error(message(locale, "docs.storeMissing"));
      return 3;
    }
    return docsStatus(stores, locale);
  }
  if (action === "decide") {
    if (stores.length === 0) {
      console.error(message(locale, "docs.storeMissing"));
      return 3;
    }
    return docsDecide(rest, stores, locale);
  }
  if (action !== "check") {
    console.error(message(locale, "docs.usage"));
    return 3;
  }
  if (stores.length === 0) {
    console.error(message(locale, "docs.storeMissing"));
    return 3;
  }
  const staged = rest.includes("--staged");
  const json = rest.includes("--json");
  const unfilledOnly = rest.includes("--unfilled");
  const explicit = parseOptionValues(rest, "--changed");
  const reports: DocumentCheckReport[] = [];
  for (const store of stores) {
    const inputs = explicit.length > 0
      ? explicitAbsolutePaths(store, explicit)
      : (staged ? explicitAbsolutePaths(store, gitPaths(store.gitRoot, true)) : []);
    const result = checkDocuments({
      store,
      ...(explicit.length > 0 || staged ? { changedPaths: inputs } : {}),
      ...(staged ? { stagedContent: stagedContent(store.gitRoot, inputs) } : {}),
    });
    reports.push(result);
    if (json) continue;
    if (unfilledOnly) {
      for (const path of result.unfilled) console.log(message(locale, "docs.unfilledEntry", { path }));
      continue;
    }
    print(result, store.scopeRoot, locale);
  }
  if (json) jsonReport(stores, reports);
  const unfilledCount = reports.reduce((total, report) => total + report.unfilled.length, 0);
  return (unfilledOnly || explicit.length > 0 || staged) && unfilledCount > 0 ? 1 : 0;
};
