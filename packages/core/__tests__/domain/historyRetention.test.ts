import { describe, expect, it } from "vitest";
import { computeCrl } from "../../src/domain/crl";
import { compactHistoryRecords, type SealedHistoryRecord } from "../../src/domain/historyRetention";

const values = (history: readonly { readonly timestamp: string; readonly deltas: readonly { readonly file: string; readonly deltaI: number }[] }[], now: Date): ReadonlyMap<string, number> =>
  computeCrl(history, now);

const expectEquivalent = (left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): void => {
  expect([...left.keys()].sort()).toEqual([...right.keys()].sort());
  for (const [file, value] of left) expect(right.get(file)).toBeCloseTo(value, 12);
};

describe("history retention checkpoint", () => {
  const records: readonly SealedHistoryRecord[] = [
    { entryId: "first", timestamp: "2026-01-01T00:00:00.000Z", deltas: [{ file: "src/a.ts", deltaI: 12 }] },
    { entryId: "second", timestamp: "2026-02-01T00:00:00.000Z", deltas: [{ file: "src/a.ts", deltaI: 4 }, { file: "src/b.ts", deltaI: 7 }] },
    { entryId: "recent", timestamp: "2026-06-15T00:00:00.000Z", deltas: [{ file: "src/b.ts", deltaI: 3 }] },
  ];

  it("replays compacted and retained entries exactly like complete history", () => {
    const cutoff = new Date("2026-03-01T00:00:00.000Z");
    const result = compactHistoryRecords(undefined, records, cutoff);
    const now = new Date("2026-08-01T00:00:00.000Z");

    expect(result.compactedEntries).toBe(2);
    expect(result.retained.map((record) => record.entryId)).toEqual(["recent"]);
    expect(result.checkpoint?.sourceEntryCount).toBe(2);
    expectEquivalent(
      values(records, now),
      values([{ timestamp: result.checkpoint!.compactedAt, deltas: result.checkpoint!.deltas }, ...result.retained], now),
    );
  });

  it("advances an existing checkpoint without changing replay semantics", () => {
    const first = compactHistoryRecords(undefined, records, new Date("2026-03-01T00:00:00.000Z"));
    const nextRecords = [...first.retained, { entryId: "third", timestamp: "2026-04-01T00:00:00.000Z", deltas: [{ file: "src/c.ts", deltaI: 9 }] }];
    const second = compactHistoryRecords(first.checkpoint, nextRecords, new Date("2026-05-01T00:00:00.000Z"));
    const now = new Date("2026-09-01T00:00:00.000Z");

    expect(second.checkpoint?.sourceEntryCount).toBe(3);
    expectEquivalent(
      values([
        { timestamp: first.checkpoint!.compactedAt, deltas: first.checkpoint!.deltas },
        ...nextRecords,
      ], now),
      values([{ timestamp: second.checkpoint!.compactedAt, deltas: second.checkpoint!.deltas }, ...second.retained], now),
    );
  });

  it("is a no-op when no additional raw entry crosses the cutoff", () => {
    const first = compactHistoryRecords(undefined, records, new Date("2026-03-01T00:00:00.000Z"));
    const repeated = compactHistoryRecords(first.checkpoint, first.retained, new Date("2026-03-01T12:00:00.000Z"));

    expect(repeated.compactedEntries).toBe(0);
    expect(repeated.checkpoint).toEqual(first.checkpoint);
    expect(repeated.retained).toEqual(first.retained);
  });

  it("does not amplify a future-dated history record after clock rollback", () => {
    const crl = values([
      { timestamp: "2026-08-02T00:00:00.000Z", deltas: [{ file: "src/future.ts", deltaI: 10 }] },
    ], new Date("2026-08-01T00:00:00.000Z"));

    expect(crl.get("src/future.ts")).toBe(10);
  });
});
