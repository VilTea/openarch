import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { calibrationThresholdShifts } from "../../../src/application/governance/calibrationGate";
import { createStructuralCalibrationProfile, localBurdenFingerprint } from "../../../src/domain/calibration";
import { DEFAULT_CRL_STATE_WEIGHTS } from "../../../src/domain/crlState";
import { CelAdapterLive } from "../../../src/adapter/rule/CelAdapter";

const p95 = (branch: number) => ({ branch, nesting: 4, loc: 30, alpha: 0.5, oneMinusConnectedness: 0.5, externalPassthrough: 10 });
const raw = { path: "src/stable.ts", maxFuncBranch: 4, nestingDepth: 1, loc: 10, alphaStruct: 0.1, connectedness: 1, externalPassthroughCalls: 1 };
const profile = (branch: number, extra: string) => createStructuralCalibrationProfile({
  analysisScopeFingerprint: "scope", metricContractVersion: "metrics", p95: p95(branch), weights: DEFAULT_CRL_STATE_WEIGHTS,
  population: [raw, { ...raw, path: `src/${extra}.ts`, maxFuncBranch: branch }],
});

describe("calibrationThresholdShifts", () => {
  it("reports a pure crl_local threshold crossing without changing policy evaluation", async () => {
    const fingerprint = localBurdenFingerprint(raw);
    const result = await Effect.runPromise(calibrationThresholdShifts({
      profiles: { gate: profile(10, "old"), current: profile(5, "new") },
      rules: [{ name: "local burden", condition: "crl_local > 0.2", level: "warn" }],
      metrics: [{ ...raw, branchCount: 4, weightedBranchTotal: 4, topLevelWeightedBranch: 0, cohesion: 1, fileKind: "production", localBurdenFingerprint: fingerprint, previousLocalBurdenFingerprint: fingerprint }],
      paths: [{ name: "default", pattern: "**" }], weights: DEFAULT_CRL_STATE_WEIGHTS,
    }).pipe(Effect.provide(CelAdapterLive)));
    expect(result).toEqual([expect.objectContaining({
      path: "src/stable.ts", gateRules: [], observedRules: ["local burden"],
    })]);
  });

  it("does not classify a mixed dynamic rule as denominator-only", async () => {
    const fingerprint = localBurdenFingerprint(raw);
    const result = await Effect.runPromise(calibrationThresholdShifts({
      profiles: { gate: profile(10, "old"), current: profile(5, "new") },
      rules: [{ name: "mixed", condition: "crl_local > 0.1 && exposure > 0", level: "warn" }],
      metrics: [{ ...raw, branchCount: 4, cohesion: 1, fileKind: "production", localBurdenFingerprint: fingerprint, previousLocalBurdenFingerprint: fingerprint }],
      paths: [{ name: "default", pattern: "**" }], weights: DEFAULT_CRL_STATE_WEIGHTS,
    }).pipe(Effect.provide(CelAdapterLive)));
    expect(result).toEqual([]);
  });
});
