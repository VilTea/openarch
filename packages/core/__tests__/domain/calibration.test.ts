import { describe, expect, it } from "vitest";
import { createStructuralCalibrationProfile, nextStructuralCalibrationState, STRUCTURAL_CALIBRATION_BOUNDARY } from "../../src/domain/calibration";
import { DEFAULT_CRL_STATE_WEIGHTS } from "../../src/domain/crlState";

const profile = (branch: number, path: string) => createStructuralCalibrationProfile({
  analysisScopeFingerprint: "scope",
  metricContractVersion: "metrics",
  p95: { branch, nesting: 2, loc: 10, alpha: 0.5, oneMinusConnectedness: 0.5, externalPassthrough: 3 },
  weights: DEFAULT_CRL_STATE_WEIGHTS,
  population: [{ path, maxFuncBranch: branch, nestingDepth: 1, loc: 5, alphaStruct: 0.1, connectedness: 1, externalPassthroughCalls: 0 }],
});

describe("structural calibration state", () => {
  it("declares a durable baseline boundary with legacy absence support", () => {
    expect(STRUCTURAL_CALIBRATION_BOUNDARY).toEqual({
      classification: "persisted", storage: "baseline-index", version: "structural-calibration-v1",
      unknownVersion: "reject", missingVersion: "legacy-supported",
    });
  });

  it("keeps the gate epoch through ordinary observed profile changes", () => {
    const initial = profile(4, "initial.ts");
    const observed = profile(8, "observed.ts");
    const result = nextStructuralCalibrationState({ observed, previous: { current: initial, gate: initial } });
    expect(result.transition).toBe("retained");
    expect(result.state).toMatchObject({ current: observed, previous: initial, gate: initial });
  });

  it("bootstraps a legacy state from its prior current profile and seals only on request", () => {
    const legacy = profile(4, "legacy.ts");
    const observed = profile(8, "observed.ts");
    const bootstrapped = nextStructuralCalibrationState({ observed, previous: { current: legacy } });
    expect(bootstrapped.transition).toBe("bootstrapped");
    expect(bootstrapped.state.gate).toEqual(legacy);

    const sealed = nextStructuralCalibrationState({ observed, previous: bootstrapped.state, sealGate: true });
    expect(sealed.transition).toBe("sealed");
    expect(sealed.state.gate).toEqual(observed);
  });
});
