import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createQueryResultCache } from "../../src/adapter/parser/QueryResultCache";

describe("QueryResultCache", () => {
  const root = mkdtempSync(join(tmpdir(), "openarch-query-cache-"));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const sample = [
    { captures: [{ name: "callee", text: "expect", startLine: 3, endLine: 3, startIndex: 10, endIndex: 16 }] },
  ];

  it("round-trips valid matches and keys every dependency", () => {
    const cache = createQueryResultCache(root);
    const keyA = cache.keyFor("expect(1)", "(identifier) @callee", "grammar-a");
    const keyB = cache.keyFor("expect(1)", "(identifier) @callee", "grammar-b");
    const keyC = cache.keyFor("expect(2)", "(identifier) @callee", "grammar-a");
    const keyD = cache.keyFor("expect(1)", "(identifier) @other", "grammar-a");
    expect(new Set([keyA, keyB, keyC, keyD]).size).toBe(4);

    cache.put(keyA, sample);
    expect(cache.get(keyA)).toEqual(sample);
    expect(cache.get(keyB)).toBeUndefined();
  });

  it("discards corrupt or structurally invalid entries", () => {
    const cache = createQueryResultCache(root);
    const key = cache.keyFor("corrupt", "(identifier) @x", "g");
    cache.put(key, sample);
    const path = join(root, `${key}.json`);
    writeFileSync(path, "{ broken json", "utf8");
    expect(cache.get(key)).toBeUndefined();

    const other = cache.keyFor("wrong-shape", "(identifier) @x", "g");
    writeFileSync(join(root, `${other}.json`), JSON.stringify({ captures: [{ no: true }] }), "utf8");
    expect(cache.get(other)).toBeUndefined();
  });

  it("keeps the directory bounded for non-test usage only after write", () => {
    const isolated = mkdtempSync(join(root, "bounded-"));
    try {
      const cache = createQueryResultCache(isolated);
      for (let i = 0; i < 3; i += 1) {
        cache.put(cache.keyFor(`body-${i}`, "(identifier) @x", "g"), sample);
      }
      expect(readdirSync(isolated).filter((name) => name.endsWith(".json")).length).toBe(3);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});
