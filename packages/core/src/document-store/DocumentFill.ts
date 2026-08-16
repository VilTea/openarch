import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DocumentStore } from "./DocumentStore";

/** Generated record templates carry one of these provenance lines as their own
 *  line; only those documents participate in unfilled detection, so ordinary
 *  Markdown (including capability assets that merely quote the markers) is
 *  never flagged. Templates are generated in the locale chosen at record time. */
const RECORD_ORIGIN = /^[ \t]*(?:来源|source): openarch docs record[ \t]*$/imu;
const UNFILLED_SECTION = /<!--\s*(?:必填|required)/iu;

export const isUnfilledRecordDocument = (content: string): boolean =>
  RECORD_ORIGIN.test(content) && UNFILLED_SECTION.test(content);

/**
 * Lists record templates whose required sections are still placeholders.
 * `changed` is a set of store-relative paths, exactly as produced by
 * `updateDocumentIndex`; `stagedContent` mirrors the pre-commit bytes.
 */
export const unfilledDocuments = (
  store: DocumentStore,
  changed: ReadonlySet<string>,
  stagedContent?: ReadonlyMap<string, string>,
): readonly string[] => {
  const unfilled: string[] = [];
  for (const relativePath of changed) {
    if (!relativePath || relativePath.startsWith("../") || !relativePath.toLowerCase().endsWith(".md")) continue;
    const absolute = join(store.scopeRoot, relativePath);
    const content = stagedContent?.get(absolute) ?? (existsSync(absolute) ? readFileSync(absolute, "utf8") : null);
    if (content !== null && isUnfilledRecordDocument(content)) unfilled.push(relativePath);
  }
  return unfilled;
};
