import { describe, expect, it, vi } from "vitest";
import type { Parser } from "web-tree-sitter";
import { createParseTreeCache } from "../../src/adapter/parser/TreeCache";

describe("TreeCache", () => {
  it("reuses the tree for identical path+content and reparses when content changes", () => {
    const parser = {
      parse: vi.fn((code: string) => ({ rootNode: { text: code } })),
    } as unknown as Parser;
    const cache = createParseTreeCache(4);
    expect(cache.rootFor(parser, "src/a.ts", "one")).toEqual({ text: "one" });
    expect(cache.rootFor(parser, "src/a.ts", "one")).toEqual({ text: "one" });
    expect(parser.parse).toHaveBeenCalledTimes(1);
    expect(cache.rootFor(parser, "src/a.ts", "two")).toEqual({ text: "two" });
    expect(parser.parse).toHaveBeenCalledTimes(2);
    expect(cache.rootFor(parser, "src/a.ts", "one")).toEqual({ text: "one" });
    expect(parser.parse).toHaveBeenCalledTimes(3);
  });

  it("keeps at most maxEntries files (simple LRU)", () => {
    const parser = {
      parse: vi.fn((code: string) => ({ rootNode: { text: code } })),
    } as unknown as Parser;
    const cache = createParseTreeCache(2);
    cache.rootFor(parser, "src/a.ts", "a");
    cache.rootFor(parser, "src/b.ts", "b");
    cache.rootFor(parser, "src/c.ts", "c");
    expect(cache.size).toBe(2);
    // a 已被淘汰，重新解析；b/c 复用。
    cache.rootFor(parser, "src/a.ts", "a");
    expect(parser.parse).toHaveBeenCalledTimes(4);
  });
});
