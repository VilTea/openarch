// mergeBySource 单元测试——验证按 source 合并语义
import { describe, it, expect } from "vitest";
import { mergeBySource } from "../../src/implicit-deps/merge";
import type { StoredEdge, DiscoveredEdge } from "../../src/implicit-deps/types";

const mkStored = (over: Partial<StoredEdge> = {}): StoredEdge => ({
  from: "a.ts", to: "b.ts", via: "kafka:t", type: "message_queue", source: "kafka.mjs", confidence: "low", ...over,
});

const mkDiscovered = (over: Partial<DiscoveredEdge> = {}): DiscoveredEdge => ({
  from: "a.ts", to: "b.ts", via: "kafka:t", type: "message_queue", ...over,
});

describe("mergeBySource", () => {
  it("空 existing + 新发现 → 全部压入（标 low + source）", () => {
    const result = mergeBySource([], [mkDiscovered({ from: "p.ts", to: "c.ts", via: "db:users" })], "kafka.mjs");
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("kafka.mjs");
    expect(result[0].confidence).toBe("low");
  });

  it("同 source 替换旧边，保留其他 source", () => {
    const existing = [mkStored({ source: "kafka.mjs", from: "old.ts" }), mkStored({ source: "rpc.mjs", from: "r.ts" })];
    const result = mergeBySource(existing, [mkDiscovered({ from: "new.ts" })], "kafka.mjs");
    expect(result).toHaveLength(2); // 新 kafka 边 + rpc.mjs 旧边
    expect(result.find(e => e.source === "kafka.mjs")!.from).toBe("new.ts"); // 替换
    expect(result.find(e => e.source === "rpc.mjs")!.from).toBe("r.ts");     // 保留
  });

  it("source: manual 边永不被替换", () => {
    const existing = [mkStored({ source: "manual", from: "hand.ts", note: "人手加" })];
    const result = mergeBySource(existing, [mkDiscovered({ from: "auto.ts" })], "kafka.mjs");
    expect(result.find(e => e.source === "manual")!.from).toBe("hand.ts");
    expect(result.find(e => e.source === "kafka.mjs")!.from).toBe("auto.ts");
  });

  it("空 discovered → 保留原有全部（删空该 source 的旧边）", () => {
    const existing = [mkStored({ source: "kafka.mjs" }), mkStored({ source: "rpc.mjs" })];
    const result = mergeBySource(existing, [], "kafka.mjs");
    // kafka.mjs 旧边替换为空 → 只剩 rpc.mjs
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("rpc.mjs");
  });
});
