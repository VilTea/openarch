import { describe, expect, it } from "vitest";
import { incrementalChangeSet } from "../../src/application/scanIncremental";

describe("incrementalChangeSet（per-file sha256 内容身份变更检测）", () => {
  const previous = new Map<string, string | undefined>([
    ["/repo/a.ts", "hash-a"],
    ["/repo/b.ts", "hash-b"],
    ["/repo/legacy.ts", "hash-legacy"],
  ]);

  it("detects modified files by hash difference", () => {
    const current = new Map<string, string>([
      ["/repo/a.ts", "hash-a-changed"],
      ["/repo/b.ts", "hash-b"],
      ["/repo/legacy.ts", "hash-legacy"],
    ]);
    const { changed, deleted } = incrementalChangeSet(previous, current);
    expect(changed).toEqual(["/repo/a.ts"]);
    expect(deleted).toEqual([]);
  });

  it("detects added files (no previous hash, current present)", () => {
    const current = new Map<string, string>([
      ["/repo/a.ts", "hash-a"],
      ["/repo/b.ts", "hash-b"],
      ["/repo/legacy.ts", "hash-legacy"],
      ["/repo/new.ts", "hash-new"],
    ]);
    const { changed, deleted } = incrementalChangeSet(previous, current);
    expect(changed).toContain("/repo/new.ts");
    expect(deleted).toEqual([]);
  });

  it("detects deleted files (previous hash present, current absent)", () => {
    const current = new Map<string, string>([
      ["/repo/a.ts", "hash-a"],
      ["/repo/b.ts", "hash-b"],
    ]);
    const { changed, deleted } = incrementalChangeSet(previous, current);
    expect(changed).toEqual([]);
    expect(deleted).toEqual(["/repo/legacy.ts"]);
  });

  it("returns no changes when all hashes match", () => {
    const current = new Map<string, string>([
      ["/repo/a.ts", "hash-a"],
      ["/repo/b.ts", "hash-b"],
      ["/repo/legacy.ts", "hash-legacy"],
    ]);
    const { changed, deleted } = incrementalChangeSet(previous, current);
    expect(changed).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("treats missing previous hash as undefined (no change) rather than deleted", () => {
    // 旧 baseline 无 contentSha256：previous 值 undefined——不属于 deleted（需 hash 存在）
    const legacyPrevious = new Map<string, string | undefined>([
      ["/repo/a.ts", undefined],
    ]);
    const current = new Map<string, string>([["/repo/a.ts", "hash-a"]]);
    const { changed, deleted } = incrementalChangeSet(legacyPrevious, current);
    // undefined !== "hash-a" → 判定 changed（会全量重算该文件，正确但保守）
    expect(changed).toEqual(["/repo/a.ts"]);
    expect(deleted).toEqual([]);
  });
});
