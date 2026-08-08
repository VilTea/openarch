import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeJsonFileStorageLive } from "../../src/adapter/storage/JsonFileStorage";
import { SymbolCalibrationStore } from "../../src/port/SymbolCalibrationStore";
import type { SymbolCalibrationProfile } from "../../src/domain/symbolCalibration";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

const profile = (id: string): SymbolCalibrationProfile => ({
  schemaVersion: 1,
  id,
  language: "typescript",
  providerId: "typescript-symbol-use",
  declarationFamily: "callable",
  commonPopulationFingerprint: "population-a",
  samples: [
    { id: "positive", language: "typescript", providerId: "typescript-symbol-use", declarationFamily: "callable", commonPopulationFingerprint: "population-a", expected: "matched", observed: "matched", availability: "available" },
    { id: "negative", language: "typescript", providerId: "typescript-symbol-use", declarationFamily: "callable", commonPopulationFingerprint: "population-a", expected: "rejected", observed: "rejected", availability: "available" },
  ],
  positiveSampleCount: 1,
  negativeSampleCount: 1,
  availability: "available",
  eligible: true,
  reasons: [],
});

describe("JsonSymbolCalibrationStore", () => {
  it("persists content-addressed profiles idempotently and lists them", async () => {
    await withTemporaryDirectory("symbol-calibration-store", async (root) => {
      const layer = makeJsonFileStorageLive(root);
      const value = profile("symbol-calibration:profile-a");
      await Effect.runPromise(Effect.gen(function* () {
        const store = yield* SymbolCalibrationStore;
        yield* store.writeProfile(value);
        const first = readFileSync(join(root, "calibration", "symbol", readdirSync(join(root, "calibration", "symbol"))[0]!), "utf8");
        yield* store.writeProfile(value);
        expect(readFileSync(join(root, "calibration", "symbol", readdirSync(join(root, "calibration", "symbol"))[0]!), "utf8")).toBe(first);
        expect(yield* store.readProfile(value.id)).toEqual(value);
        expect(yield* store.listProfiles()).toEqual([value]);
      }).pipe(Effect.provide(layer)));
    });
  });

  it("keeps profile storage separate from baseline and rejects invalid profiles", async () => {
    await withTemporaryDirectory("symbol-calibration-invalid", async (root) => {
      const layer = makeJsonFileStorageLive(root);
      await Effect.runPromise(Effect.gen(function* () {
        const store = yield* SymbolCalibrationStore;
        const result = yield* Effect.either(store.writeProfile({ id: "invalid" } as SymbolCalibrationProfile));
        expect(result._tag).toBe("Left");
        const unsupported = yield* Effect.either(store.writeProfile({ ...profile("unsupported"), schemaVersion: 2 } as SymbolCalibrationProfile));
        expect(unsupported._tag).toBe("Left");
        expect(yield* store.readProfile("missing")).toBeNull();
      }).pipe(Effect.provide(layer)));
    });
  });
});
