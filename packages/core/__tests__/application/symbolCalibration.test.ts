import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeJsonFileStorageLive } from "../../src/adapter/storage/JsonFileStorage";
import { loadSymbolCalibrationProfiles, recordSymbolCalibrationProfile } from "../../src/application/symbolCalibration";
import type { SymbolVersionPairReport } from "../../src/domain/symbolVersionPair";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

const report = (status: "matched" | "removed"): SymbolVersionPairReport => ({
  language: "typescript",
  availability: "available",
  population: { beforeRevision: "before", afterRevision: "after", files: ["src/api.ts"], fingerprint: "revision-population" },
  before: {
    origin: { language: "typescript", providerId: "typescript-symbol-use", evidenceSource: "compiler" },
    state: { availability: "available", coverage: { declarations: "complete", repositoryReferences: "complete" } },
    scope: { mode: "repository", governedFileCount: 1, selectedDeclarationFileCount: 1, declarationFamilies: ["callable"] },
    facts: [{ language: "typescript", declaration: { file: "src/api.ts", name: "worker", kind: "function", line: 1 }, repositoryReferences: [], publicSurface: "internal" }],
  },
  after: {
    origin: { language: "typescript", providerId: "typescript-symbol-use", evidenceSource: "compiler" },
    state: { availability: "available", coverage: { declarations: "complete", repositoryReferences: "complete" } },
    scope: { mode: "repository", governedFileCount: 1, selectedDeclarationFileCount: 1, declarationFamilies: ["callable"] },
    facts: [{ language: "typescript", declaration: { file: "src/api.ts", name: "worker", kind: "function", line: 1 }, repositoryReferences: [], publicSurface: "internal" }],
  },
  declarations: [{ identity: "typescript\0src/api.ts\0function\0worker", status, before: { language: "typescript", declaration: { file: "src/api.ts", name: "worker", kind: "function", line: 1 }, repositoryReferences: [], publicSurface: "internal" }, ...(status === "matched" ? { after: { language: "typescript", declaration: { file: "src/api.ts", name: "worker", kind: "function", line: 1 }, repositoryReferences: [], publicSurface: "internal" } } : {}) }],
});

describe("symbol calibration application", () => {
  it("records and reloads an explicit historical profile", async () => {
    await withTemporaryDirectory("symbol-calibration-application", async (root) => {
      const layer = makeJsonFileStorageLive(root);
      const profile = await Effect.runPromise(recordSymbolCalibrationProfile([
        { report: report("matched"), id: "positive", identity: "typescript\0src/api.ts\0function\0worker", expected: "matched" },
        { report: report("removed"), id: "negative", identity: "typescript\0src/api.ts\0function\0worker", expected: "rejected" },
      ]).pipe(Effect.provide(layer)));
      expect(profile.eligible).toBe(true);
      const loaded = await Effect.runPromise(loadSymbolCalibrationProfiles().pipe(Effect.provide(layer)));
      expect(loaded).toEqual([profile]);
    });
  });
});
