import { describe, expect, it } from "vitest";
import { replayHistoricalCrl } from "../../../src/application/governance/historyCrl";

describe("historical CRL Fact", () => {
  it("replays the storage projection without a baseline cache", () => {
    const crl = replayHistoricalCrl([["2026-07-18T00:00:00.000Z", [{ file: "src/a.ts", deltaI: 8 }]]], new Date("2026-07-18T00:00:00.000Z"));
    expect(crl.get("src/a.ts")).toBeGreaterThan(7.9);
  });
});
