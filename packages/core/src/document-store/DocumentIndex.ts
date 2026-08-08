import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DocumentStore } from "./DocumentStore";
import { documentIndexPath } from "./DocumentStore";
import { INDEX_VERSION, type IndexedDocument } from "./DocumentFingerprint";

export interface DocumentIndex {
  readonly version: typeof INDEX_VERSION;
  readonly scopeId: string;
  readonly entries: Readonly<Record<string, IndexedDocument>>;
}

export const readDocumentIndex = (store: DocumentStore): DocumentIndex => {
  try {
    const value = JSON.parse(readFileSync(documentIndexPath(store), "utf8")) as DocumentIndex;
    if (value.version === INDEX_VERSION && value.scopeId === store.scopeId && value.entries) return value;
  } catch { /* cache miss or invalidation */ }
  return { version: INDEX_VERSION, scopeId: store.scopeId, entries: {} };
};

export const writeDocumentIndex = (store: DocumentStore, index: DocumentIndex): void => {
  const path = documentIndexPath(store);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  renameSync(temp, path);
};

export const markdownFiles = (root: string): readonly string[] => {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".openarch") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(path);
    }
  };
  visit(resolve(root));
  return files;
};
