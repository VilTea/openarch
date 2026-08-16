import { describe, expect, it } from "vitest";
import {
  impactFileCountBucket,
  impactIntensityOf,
  impactScaleOf,
  type HistoryImpactFact,
} from "../../src/domain/impactCalibration";

const fact = (iPush: number, fileCount: number, entryCount = 1): HistoryImpactFact => ({
  timestamp: "2026-08-15T00:00:00.000Z", iPush, fileCount, entryCount,
});

describe("impactIntensityOf", () => {
  it("is the structural impact per semantic-severity unit", () => {
    expect(impactIntensityOf(90, 45)).toBeCloseTo(2, 5);
  });

  it("stays at zero for a comment-only change with no severity budget", () => {
    expect(impactIntensityOf(0, 0)).toBe(0);
  });
});

describe("impactFileCountBucket", () => {
  it("partitions by change-set size", () => {
    expect(impactFileCountBucket(1)?.label).toBe("1");
    expect(impactFileCountBucket(3)?.label).toBe("2-3");
    expect(impactFileCountBucket(9)?.label).toBe("4-9");
    expect(impactFileCountBucket(19)?.label).toBe("10-19");
    expect(impactFileCountBucket(40)?.label).toBe("20+");
  });

  it("never matches a zero-file change", () => {
    expect(impactFileCountBucket(0)).toBeUndefined();
  });
});

describe("impactScaleOf", () => {
  it("compares only within the same file-count bucket", () => {
    const facts = [
      fact(1000, 1), // ignored: different bucket
      fact(10, 2),
      fact(30, 2),
      fact(50, 2),
      fact(80, 2),
    ];
    // bucket 2-3: 10,30,50,80; value 40 exceeds two of four
    expect(impactScaleOf(40, 2, facts)).toEqual({ percentile: 50, bucket: "2-3", sampleEntries: 4 });
  });

  it("weights compacted checkpoints by sourceEntryCount instead of treating them as one change", () => {
    const facts = [fact(10, 1, 3), fact(30, 1, 1)];
    // value 20 exceeds three entries out of four
    expect(impactScaleOf(20, 1, facts)).toEqual({ percentile: 75, bucket: "1", sampleEntries: 4 });
  });

  it("returns undefined when the bucket has no sealed sample", () => {
    expect(impactScaleOf(5, 20, [fact(5, 1)])).toBeUndefined();
  });
});
