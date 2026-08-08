import { Effect } from "effect";
import { metricIdsInCondition } from "../../domain/metricCatalog";
import type { CRLStateWeights } from "../../domain/crlState";
import { gateCalibrationProfile, type StructuralCalibrationState } from "../../domain/calibration";
import type { GateFileMetric } from "./gateReport";
import { gatePerFile, type GateRule, type PathEntry } from "./gate";
import { calibrationShiftCandidates } from "./calibrationSignals";

export interface CalibrationShift {
  readonly path: string;
  readonly gateLocalBurden: number;
  readonly observedLocalBurden: number;
  readonly gateRules: readonly string[];
  readonly observedRules: readonly string[];
}

export type CalibrationProfiles = StructuralCalibrationState;

/** Mixed dynamic predicates cannot support a denominator-only conclusion. */
const localBurdenOnlyRules = (rules: readonly GateRule[]): readonly GateRule[] => rules.filter((rule) => {
  const metricIds = metricIdsInCondition(rule.condition);
  return metricIds.includes("crl_local") && metricIds.every((id) => id === "crl_local");
});

const triggerNames = (triggered: readonly { readonly name: string; readonly file?: string }[], path: string): readonly string[] =>
  triggered.filter((trigger) => trigger.file === path).map((trigger) => trigger.name).sort();

/**
 * Reuses the ordinary gate evaluator with sealed/observed P95. It never
 * changes the gate verdict; a result explains a calibration epoch difference.
 */
export const calibrationThresholdShifts = (input: {
  readonly profiles?: CalibrationProfiles;
  readonly rules: readonly GateRule[];
  readonly metrics: readonly GateFileMetric[];
  readonly paths: readonly PathEntry[];
  readonly weights: CRLStateWeights;
}) => Effect.gen(function* () {
  const gateProfile = gateCalibrationProfile(input.profiles);
  const observedProfile = input.profiles?.current;
  const candidates = calibrationShiftCandidates(input.metrics, gateProfile, observedProfile, input.weights);
  const rules = localBurdenOnlyRules(input.rules);
  if (candidates.length === 0 || rules.length === 0 || !gateProfile || !observedProfile) return [] as readonly CalibrationShift[];

  const metricsByPath = new Map(input.metrics.map((metric) => [metric.path, metric]));
  const candidateMetrics = candidates.flatMap((candidate) => {
    const metric = metricsByPath.get(candidate.path);
    return metric ? [metric] : [];
  });
  const [gate, observed] = yield* Effect.all([
    gatePerFile(rules, candidateMetrics, input.paths, { p95: gateProfile.p95, weights: input.weights }),
    gatePerFile(rules, candidateMetrics, input.paths, { p95: observedProfile.p95, weights: input.weights }),
  ]);
  return candidates.map((candidate) => ({
    path: candidate.path,
    gateLocalBurden: candidate.previousLocalBurden,
    observedLocalBurden: candidate.currentLocalBurden,
    gateRules: triggerNames(gate.triggered, candidate.path),
    observedRules: triggerNames(observed.triggered, candidate.path),
  })).filter((candidate) => candidate.gateRules.join("\u0000") !== candidate.observedRules.join("\u0000"));
});
