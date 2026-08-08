import { describe, expect, it } from "vitest";
import { calibrationShiftCandidates } from "../../../src/application/governance/calibrationSignals";
import { createStructuralCalibrationProfile, localBurdenFingerprint } from "../../../src/domain/calibration";
import { DEFAULT_CRL_STATE_WEIGHTS } from "../../../src/domain/crlState";

const raw = { path: "src/stable.ts", maxFuncBranch: 4, nestingDepth: 2, loc: 20, alphaStruct: 0.2, connectedness: 1, externalPassthroughCalls: 6 };
const profile = (externalPassthrough: number, populationSuffix: string) => createStructuralCalibrationProfile({
  analysisScopeFingerprint: "scope", metricContractVersion: "metrics",
  p95: { branch: 5, nesting: 4, loc: 30, alpha: 0.5, oneMinusConnectedness: 0.5, externalPassthrough },
  population: [raw, { ...raw, path: `src/${populationSuffix}.ts`, externalPassthroughCalls: externalPassthrough }],
  weights: DEFAULT_CRL_STATE_WEIGHTS,
});

describe("calibrationShiftCandidates", () => {
  it("keeps unchanged local inputs and exposes only their denominator-driven movement", () => {
    const fingerprint = localBurdenFingerprint(raw);
    const candidates = calibrationShiftCandidates([{
      ...raw, fileKind: "production", branchCount: 4, inDegree: 0, outDegree: 0,
      localBurdenFingerprint: fingerprint, previousLocalBurdenFingerprint: fingerprint,
    }], profile(12, "old"), profile(6, "new"), DEFAULT_CRL_STATE_WEIGHTS);
    expect(candidates).toEqual([expect.objectContaining({ path: "src/stable.ts", previousLocalBurden: expect.any(Number), currentLocalBurden: expect.any(Number) })]);
    expect(candidates[0].currentLocalBurden).toBeGreaterThan(candidates[0].previousLocalBurden);
  });

  it("does not claim a denominator-only movement after local input or weight changes", () => {
    const fingerprint = localBurdenFingerprint(raw);
    expect(calibrationShiftCandidates([{
      ...raw, fileKind: "production", branchCount: 4, inDegree: 0, outDegree: 0,
      localBurdenFingerprint: fingerprint, previousLocalBurdenFingerprint: "different",
    }], profile(12, "old"), profile(6, "new"), DEFAULT_CRL_STATE_WEIGHTS)).toEqual([]);
    expect(calibrationShiftCandidates([{
      ...raw, fileKind: "production", branchCount: 4, inDegree: 0, outDegree: 0,
      localBurdenFingerprint: fingerprint, previousLocalBurdenFingerprint: fingerprint,
    }], profile(12, "old"), { ...profile(6, "new"), weightsFingerprint: "changed" }, DEFAULT_CRL_STATE_WEIGHTS)).toEqual([]);
  });
});
