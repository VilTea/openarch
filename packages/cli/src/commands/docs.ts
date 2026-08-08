import { execFileSync, execSync } from "node:child_process";
import { resolve } from "node:path";
import { checkDocuments, resolveDocumentStores, type DocumentCheckReport } from "@openarch/core";
import { CommandHandler, parseOptionValues } from "../runtime";
import { message } from "../i18n";
import { recordCommand } from "./record";
import { statusCommand } from "./status";

const gitPaths = (cwd: string, staged: boolean): readonly string[] => {
  try {
    const command = staged ? "git diff --cached --name-only --diff-filter=ACM" : "git diff --name-only --diff-filter=ACM";
    return execSync(command, { cwd, encoding: "utf8", timeout: 5000 }).split(/\r?\n/).map((path) => path.trim()).filter((path) => path.toLowerCase().endsWith(".md"));
  } catch {
    return [];
  }
};

const stagedContent = (gitRoot: string, paths: readonly string[]): ReadonlyMap<string, string> => {
  const content = new Map<string, string>();
  for (const path of paths) {
    try {
      content.set(resolve(gitRoot, path), execFileSync("git", ["show", `:${path}`], { cwd: gitRoot, encoding: "utf8", timeout: 5000 }));
    } catch { /* deleted or not staged */ }
  }
  return content;
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
  if (result.candidates.length === 0) {
    console.log(message(locale, "docs.noCandidates"));
    return;
  }
  console.log(message(locale, "docs.candidates", { count: result.candidates.length }));
  for (const candidate of result.candidates) {
    console.log(message(locale, "docs.candidate", { left: candidate.left, right: candidate.right, minhash: candidate.minHashSimilarity.toFixed(2), distance: candidate.simHashDistance }));
  }
};

export const docsCommand: CommandHandler = (args, context) => {
  const locale = context.locale;
  const [action, ...rest] = args;
  if (action === "record") return recordCommand(rest, context);
  if (action === "status") return statusCommand(rest, context);
  if (action !== "check") {
    console.error(message(locale, "docs.usage"));
    return 3;
  }
  const staged = rest.includes("--staged");
  const explicit = parseOptionValues(rest, "--changed");
  const stores = resolveDocumentStores(context.cwd);
  if (stores.length === 0) {
    console.error(message(locale, "docs.storeMissing"));
    return 3;
  }
  const paths = explicit.length > 0 ? explicit : gitPaths(stores[0].gitRoot, staged);
  for (const store of stores) {
    const result = checkDocuments({
      store,
      ...(rest.includes("--changed") || staged ? { changedPaths: paths } : {}),
      ...(staged ? { stagedContent: stagedContent(store.gitRoot, paths) } : {}),
    });
    print(result, store.scopeRoot, locale);
  }
  return 0;
};
