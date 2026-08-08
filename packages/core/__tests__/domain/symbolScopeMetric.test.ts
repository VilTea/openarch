import { describe, expect, it } from "vitest";
import { computeSymbolScopeMetric } from "../../src/domain/symbolScopeMetric";
import type { SymbolCalibrationProfile } from "../../src/domain/symbolCalibration";

const profile: SymbolCalibrationProfile = {
  schemaVersion: 1, id: "profile-a", language: "typescript", providerId: "typescript-symbol-use", declarationFamily: "callable", commonPopulationFingerprint: "population-a",
  samples: [], positiveSampleCount: 1, negativeSampleCount: 1, availability: "available", eligible: true, reasons: [],
};

const input = (overrides: Partial<Parameters<typeof computeSymbolScopeMetric>[0]> = {}): Parameters<typeof computeSymbolScopeMetric>[0] => ({
  language: "typescript", providerId: "typescript-symbol-use", file: "src/api.ts", symbol: "worker", declarationFamily: "callable", changeKind: "public_method_sig",
  alphaStruct: 0.5, layerWeight: 1, repositoryReferences: ["src/api.ts", "src/consumer.ts", "src/consumer.ts"], staticImportConsumers: ["src/static.ts"],
  declarationsCoverage: "complete", repositoryReferencesCoverage: "complete", publicSurface: "declared-public", commonPopulationFingerprint: "population-a", calibrationProfile: profile,
  ...overrides,
});

describe("symbol-scope shadow metric", () => {
  it("computes a deduplicated symbol impact without adding static consumers", () => {
    const result = computeSymbolScopeMetric(input());
    expect(result).toMatchObject({ formula: "lambda_ast * alpha_struct * log2(symbol_consumer_count + 1) * omega_layer", role: "shadow", availability: "available", eligible: true, symbolConsumerCount: 1, staticConsumerCount: 1 });
    expect(result.symbolScopeImpact).toBeCloseTo(60 * 0.5 * Math.log2(2));
    expect(result.staticComparableImpact).toBeCloseTo(result.symbolScopeImpact);
  });

  it("preserves unknown coverage as partial instead of zero", () => {
    const result = computeSymbolScopeMetric(input({ repositoryReferencesCoverage: "partial", repositoryReferences: [] }));
    expect(result).toMatchObject({ availability: "partial", eligible: false, reasons: ["symbol declaration or repository reference coverage is incomplete"] });
    expect(result.symbolConsumerCount).toBeUndefined();
    expect(result.symbolScopeImpact).toBeUndefined();
  });

  it("rejects mismatched profile identity and unavailable profile evidence", () => {
    const mismatch = computeSymbolScopeMetric(input({ commonPopulationFingerprint: "other" }));
    expect(mismatch).toMatchObject({ availability: "partial", eligible: false });
    expect(mismatch.reasons).toContain("metric input does not match calibration profile identity");

    const unavailable = computeSymbolScopeMetric(input({ calibrationProfile: { ...profile, availability: "unavailable", eligible: false }, repositoryReferencesCoverage: "unavailable" }));
    expect(unavailable.availability).toBe("unavailable");
    expect(unavailable.symbolScopeImpact).toBeUndefined();
  });
});
