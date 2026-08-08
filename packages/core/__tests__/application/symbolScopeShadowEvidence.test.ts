import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeJsonFileStorageLive } from "../../src/adapter/storage/JsonFileStorage";
import { evaluatePersistedSymbolScopeShadowEvidence } from "../../src/application/symbolScopeShadowEvidence";
import { SymbolCalibrationStore } from "../../src/port/SymbolCalibrationStore";
import type { SymbolCalibrationProfile } from "../../src/domain/symbolCalibration";
import type { SymbolVersionPairReport } from "../../src/domain/symbolVersionPair";
import { symbolCommonPopulationFingerprint } from "../../src/domain/symbolCalibration";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

const files = ["src/api.ts"];
const identity = "typescript\0src/api.ts\0function\0worker";
const profile: SymbolCalibrationProfile = {
  schemaVersion: 1, id: "persisted", language: "typescript", providerId: "typescript-symbol-use", declarationFamily: "callable",
  commonPopulationFingerprint: symbolCommonPopulationFingerprint(files), samples: [], positiveSampleCount: 1, negativeSampleCount: 1,
  availability: "available", eligible: true, reasons: [],
};
const fact = { language: "typescript", declaration: { file: "src/api.ts", name: "worker", kind: "function" as const, line: 1 }, repositoryReferences: [], publicSurface: "declared-public" as const };
const report: SymbolVersionPairReport = {
  language: "typescript", availability: "available",
  population: { beforeRevision: "before", afterRevision: "after", files, fingerprint: "revision" },
  before: { origin: { language: "typescript", providerId: "typescript-symbol-use", evidenceSource: "compiler" }, state: { availability: "available", coverage: { declarations: "complete", repositoryReferences: "complete" } }, facts: [fact] },
  after: { origin: { language: "typescript", providerId: "typescript-symbol-use", evidenceSource: "compiler" }, state: { availability: "available", coverage: { declarations: "complete", repositoryReferences: "complete" } }, facts: [fact] },
  declarations: [{ identity, status: "matched", before: fact, after: fact }],
};

describe("persisted symbol-scope shadow evidence", () => {
  it("loads the capability-specific calibration store without widening structural storage", async () => {
    await withTemporaryDirectory("symbol-shadow-evidence", async (root) => {
      const layer = makeJsonFileStorageLive(root);
      await Effect.runPromise(Effect.gen(function* () {
        const store = yield* SymbolCalibrationStore;
        yield* store.writeProfile(profile);
      }).pipe(Effect.provide(layer)));
      const result = await Effect.runPromise(evaluatePersistedSymbolScopeShadowEvidence({
        report, structuralInputs: [{ identity, changeKind: "public_method_sig", alphaStruct: 1, layerWeight: 1 }],
      }).pipe(Effect.provide(layer)));
      expect(result.items[0]).toMatchObject({ availability: "available", calibrationProfileId: "persisted" });
    });
  });
});
