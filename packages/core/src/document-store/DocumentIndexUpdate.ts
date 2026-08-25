import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { DocumentStore } from "./DocumentStore";
import { documentIndexPath } from "./DocumentStore";
import { contentSha256, indexedDocument, type IndexedDocument } from "./DocumentFingerprint";
import { markdownFiles, readDocumentIndex } from "./DocumentIndex";

export interface DocumentCheckInput {
  readonly store: DocumentStore;
  readonly changedPaths?: readonly string[];
  /** Absolute path -> staged bytes. Used by pre-commit to avoid reading unstaged worktree content. */
  readonly stagedContent?: ReadonlyMap<string, string>;
  /** Which verification to run. Defaults to all. */
  readonly mode?: "all" | "unfilled" | "similarity";
}

export interface DocumentIndexUpdate {
  readonly entries: Map<string, IndexedDocument>;
  readonly changed: ReadonlySet<string>;
}

const absolutePath = (store: DocumentStore, path: string): string => resolve(store.gitRoot, path);

export const documentStoreRelativePath = (store: DocumentStore, path: string): string =>
  relative(store.scopeRoot, absolutePath(store, path)).replace(/\\/g, "/");

/** Updates only the index facts implied by this check; publication remains with the use case. */
export const updateDocumentIndex = (input: DocumentCheckInput): DocumentIndexUpdate => {
  const cacheReady = existsSync(documentIndexPath(input.store));
  const allFiles = !input.changedPaths || !cacheReady ? markdownFiles(input.store.scopeRoot) : [];
  const changedPaths = !input.changedPaths || !cacheReady
    ? allFiles
    : input.changedPaths.map((path) => absolutePath(input.store, path));
  const changed = new Set(changedPaths.map((path) => documentStoreRelativePath(input.store, path)));
  const entries = new Map(Object.entries(readDocumentIndex(input.store).entries));
  const staged = input.stagedContent ?? new Map<string, string>();

  if (!input.changedPaths || !cacheReady) {
    const current = new Set(allFiles.map((path) => documentStoreRelativePath(input.store, path)));
    for (const path of entries.keys()) if (!current.has(path)) entries.delete(path);
  }

  for (const absolute of changedPaths) {
    const path = documentStoreRelativePath(input.store, absolute);
    if (!path || path.startsWith("../") || !path.toLowerCase().endsWith(".md")) continue;
    const content = staged.get(absolute) ?? (existsSync(absolute) ? readFileSync(absolute, "utf8") : null);
    if (content === null) entries.delete(path);
    else if (entries.get(path)?.contentSha256 !== contentSha256(content)) entries.set(path, indexedDocument(path, content));
  }

  return { entries, changed };
};
