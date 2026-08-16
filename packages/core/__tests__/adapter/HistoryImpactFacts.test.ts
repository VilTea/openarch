import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compactHistoryLedger, readHistoryImpactFacts, readHistoryReplayRecords } from "../../src/adapter/storage/HistoryLedger";

describe("readHistoryImpactFacts", () => {
  it("keeps raw entries distinct and weights a compaction checkpoint by sourceEntryCount", async () => {
    const root = join(tmpdir(), `openarch-impact-facts-${Date.now()}`);
    const dir = join(root, "history");
    try {
      mkdirSync(dir, { recursive: true });
      const entries = [
        { entryId: "e1", timestamp: "2026-08-01T00:00:00.000Z", deltas: [{ file: "src/a.ts", deltaI: 10, alphaStruct: 0.5 }] },
        { entryId: "e2", timestamp: "2026-08-02T00:00:00.000Z", deltas: [{ file: "src/a.ts", deltaI: 20, alphaStruct: 0.5 }, { file: "src/b.ts", deltaI: 30, alphaStruct: 0.4 }] },
        { entryId: "e3", timestamp: "2026-08-03T00:00:00.000Z", deltas: [{ file: "src/c.ts", deltaI: 40, alphaStruct: 0.3 }] },
      ];
      for (const entry of entries) writeFileSync(join(dir, `${entry.entryId}.json`), JSON.stringify(entry));

      const raw = readHistoryImpactFacts(dir);
      expect(raw).toHaveLength(3);
      expect(raw.map((fact) => fact.iPush)).toEqual([10, 50, 40]);
      expect(raw.map((fact) => fact.entryCount)).toEqual([1, 1, 1]);

      await compactHistoryLedger(dir, 0);
      const compacted = readHistoryImpactFacts(dir);
      expect(compacted).toHaveLength(1);
      // 压缩 checkpoint 的 deltaI 经时间衰减，不能拿压缩前原始和硬编码；
      // 事实投影必须与 CRL replay 的 checkpoint 一致，且保留 sourceEntryCount 权重。
      const checkpointDeltas = readHistoryReplayRecords(dir)[0][1];
      const expectedPush = checkpointDeltas.reduce((sum, delta) => sum + delta.deltaI, 0);
      expect(compacted[0]).toMatchObject({ iPush: expectedPush, entryCount: 3, fileCount: 3 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
