// packages/core/src/adapter/parser/TreeCache.ts
// Bounded in-process parse-tree cache. Every provider/rule query previously
// re-read and re-parsed the same file; this cache keys trees by file path +
// content SHA-256 so changed content can never resolve to a stale tree.
import { createHash } from "node:crypto";
import type { Node, Parser } from "web-tree-sitter";

const contentHash = (code: string): string => createHash("sha256").update(code).digest("hex");

export interface ParseTreeCache {
  readonly rootFor: (parser: Parser, filePath: string, code: string) => Node;
  readonly size: number;
}

export const createParseTreeCache = (maxEntries = 128): ParseTreeCache => {
  const entries = new Map<string, { hash: string; root: Node }>();

  const rootFor = (parser: Parser, filePath: string, code: string): Node => {
    const hash = contentHash(code);
    const cached = entries.get(filePath);
    if (cached && cached.hash === hash) {
      // Map 保序：删除后重插实现简易 LRU。
      entries.delete(filePath);
      entries.set(filePath, cached);
      return cached.root;
    }
    const tree = parser.parse(code);
    if (!tree) throw new Error("tree-sitter parse returned null");
    const entry = { hash, root: tree.rootNode };
    if (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    entries.set(filePath, entry);
    return entry.root;
  };

  return { rootFor, get size() { return entries.size; } };
};
