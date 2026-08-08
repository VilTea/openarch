import { describe, expect, it } from "vitest";
import { evaluateSymbolScopeShadowEvidence } from "../../src/domain/symbolScopeShadowEvidence";
import type { SymbolCalibrationProfile } from "../../src/domain/symbolCalibration";
import type { SymbolUseFact, SymbolUseReport } from "../../src/symbol-use/types";
import type { SymbolVersionPairReport } from "../../src/domain/symbolVersionPair";
import { symbolCommonPopulationFingerprint } from "../../src/domain/symbolCalibration";

const files = ["src/api.ts", "src/consumer.ts"];
const fingerprint = symbolCommonPopulationFingerprint(files);

const fact = (references: readonly string[], publicSurface: SymbolUseFact["publicSurface"] = "declared-public"): SymbolUseFact => ({
  language: "typescript",
  declaration: { file: "src/api.ts", name: "worker", kind: "function", line: 3 },
  repositoryReferences: references.map((file) => ({ file, line: 1 })),
  publicSurface,
});

const symbolReport = (item: SymbolUseFact, overrides: Partial<SymbolUseReport> = {}): SymbolUseReport => ({
  origin: { language: "typescript", providerId: "typescript-symbol-use", evidenceSource: "compiler" },
  state: { availability: "available", coverage: { declarations: "complete", repositoryReferences: "complete" } },
  facts: [item],
  ...overrides,
});

const report = (status: "matched" | "added" | "removed" | "ambiguous" = "matched", overrides: Partial<SymbolVersionPairReport> = {}): SymbolVersionPairReport => {
  const before = fact(["src/before-consumer.ts"]);
  const after = fact(["src/after-consumer.ts", "src/after-consumer.ts"]);
  return {
    language: "typescript", availability: "available",
    population: { beforeRevision: "before", afterRevision: "after", files, fingerprint: "revision-specific" },
    before: symbolReport(before), after: symbolReport(after),
    declarations: [{
      identity: "typescript\0src/api.ts\0function\0worker", status,
      ...(status !== "added" ? { before } : {}),
      ...(status !== "removed" ? { after } : {}),
      ...(status === "ambiguous" ? { reason: "overload collision" } : {}),
    }],
    ...overrides,
  };
};

const profile: SymbolCalibrationProfile = {
  schemaVersion: 1, id: "profile", language: "typescript", providerId: "typescript-symbol-use",
  declarationFamily: "callable", commonPopulationFingerprint: fingerprint, samples: [], positiveSampleCount: 1,
  negativeSampleCount: 1, availability: "available", eligible: true, reasons: [],
};

const structuralInput = {
  identity: "typescript\0src/api.ts\0function\0worker", changeKind: "public_method_sig" as const,
  alphaStruct: 0.5, layerWeight: 1, staticImportConsumers: ["src/static.ts"],
};

describe("symbol-scope historical shadow evidence", () => {
  it("uses after references for matched declarations and keeps static consumers parallel", () => {
    const result = evaluateSymbolScopeShadowEvidence({ report: report(), structuralInputs: [structuralInput], calibrationProfiles: [profile] });
    expect(result).toMatchObject({ availability: "available", commonPopulationFingerprint: fingerprint });
    expect(result.items[0]).toMatchObject({ pairStatus: "matched", referenceRevision: "after", availability: "available", calibrationProfileId: "profile" });
    expect(result.items[0]?.metric).toMatchObject({ symbolConsumerCount: 1, staticConsumerCount: 1 });
    expect(result.items[0]?.metric?.symbolScopeImpact).toBeCloseTo(30);
  });

  it("uses before references for removed declarations", () => {
    const result = evaluateSymbolScopeShadowEvidence({ report: report("removed"), structuralInputs: [structuralInput], calibrationProfiles: [profile] });
    expect(result.items[0]).toMatchObject({ pairStatus: "removed", referenceRevision: "before", availability: "available" });
    expect(result.items[0]?.metric?.symbolConsumerCount).toBe(1);
  });

  it("keeps ambiguous, incomplete, duplicate and unmatched historical evidence non-numeric", () => {
    const ambiguous = evaluateSymbolScopeShadowEvidence({ report: report("ambiguous"), structuralInputs: [structuralInput], calibrationProfiles: [profile] });
    expect(ambiguous.items[0]).toMatchObject({ availability: "partial", pairStatus: "ambiguous" });
    expect(ambiguous.items[0]?.metric).toBeUndefined();

    const incomplete = evaluateSymbolScopeShadowEvidence({
      report: report("matched", { after: symbolReport(fact([]), { state: { availability: "available", coverage: { declarations: "complete", repositoryReferences: "partial" } } }) }),
      structuralInputs: [structuralInput], calibrationProfiles: [profile],
    });
    expect(incomplete.items[0]).toMatchObject({ availability: "partial" });
    expect(incomplete.items[0]?.metric).toBeUndefined();

    const duplicate = evaluateSymbolScopeShadowEvidence({ report: report(), structuralInputs: [structuralInput, structuralInput], calibrationProfiles: [profile] });
    expect(duplicate.items).toHaveLength(2);
    expect(duplicate.items.every((item) => item.metric === undefined && item.availability === "partial")).toBe(true);

    const unmatched = evaluateSymbolScopeShadowEvidence({ report: report(), structuralInputs: [{ ...structuralInput, identity: "typescript\0src/api.ts\0function\0missing" }], calibrationProfiles: [profile] });
    expect(unmatched.items[0]).toMatchObject({ availability: "unavailable", pairStatus: "missing" });
  });

  it("rejects profiles that do not match the fixed population identity", () => {
    const result = evaluateSymbolScopeShadowEvidence({
      report: report(), structuralInputs: [structuralInput], calibrationProfiles: [{ ...profile, commonPopulationFingerprint: "different" }],
    });
    expect(result.items[0]).toMatchObject({ availability: "partial" });
    expect(result.items[0]?.reasons).toContain("no eligible calibration profile matches language, provider, declaration family and common population");
  });
});
