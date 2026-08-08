import { createHash } from "node:crypto";
import type { CRLStateInput, CRLStateWeights, P95Values } from "./crlState";
import type { CalibrationProfile } from "./governance";
import type { PersistedVersionBoundary } from "./persistenceBoundary";

/**
 * Baseline metadata is a durable, cross-scan boundary. Old baseline indexes
 * may omit calibration entirely; a present profile must never be reinterpreted.
 */
export const STRUCTURAL_CALIBRATION_BOUNDARY = {
  classification: "persisted",
  storage: "baseline-index",
  version: "structural-calibration-v1",
  unknownVersion: "reject",
  missingVersion: "legacy-supported",
} as const satisfies PersistedVersionBoundary<"structural-calibration-v1">;

export const STRUCTURAL_CALIBRATION_VERSION = STRUCTURAL_CALIBRATION_BOUNDARY.version;

export interface CalibrationPopulationEntry extends CRLStateInput {
  readonly path: string;
}

/** Complete normalisation evidence for structural P95 values. */
export interface StructuralCalibrationProfile extends CalibrationProfile {
  readonly version: typeof STRUCTURAL_CALIBRATION_VERSION;
  readonly p95: P95Values;
  /** A threshold transition is denominator-only only when the project weights did not change. */
  readonly weightsFingerprint: string;
}

/**
 * `current`/`previous` describe observed scan populations. `gate` is the
 * explicitly sealed denominator used by policy evaluation. Keeping them in
 * one state object prevents a second CRL or gate-calibration pipeline.
 */
export interface StructuralCalibrationState {
  readonly current: StructuralCalibrationProfile;
  readonly previous?: StructuralCalibrationProfile;
  readonly gate?: StructuralCalibrationProfile;
}

export type GateCalibrationTransition = "retained" | "bootstrapped" | "sealed";

export interface NextStructuralCalibrationState {
  readonly state: StructuralCalibrationState;
  readonly transition: GateCalibrationTransition;
}

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const numeric = (value: number | undefined): number => value ?? 0;

/** Fingerprints exactly the four raw inputs used by the current crl_local gate metric. */
export const localBurdenFingerprint = (entry: Pick<CRLStateInput, "maxFuncBranch" | "nestingDepth" | "loc" | "externalPassthroughCalls">): string =>
  hash([numeric(entry.maxFuncBranch), entry.nestingDepth, numeric(entry.loc), numeric(entry.externalPassthroughCalls)]);

export const calibrationWeightsFingerprint = (weights: CRLStateWeights): string =>
  hash([weights.branch, weights.nesting, weights.loc, weights.alpha, weights.connectedness, weights.externalPassthrough]);

/** The population includes every P95 numerator, not merely paths or the resulting percentile. */
export const calibrationPopulationFingerprint = (entries: readonly CalibrationPopulationEntry[]): string =>
  hash(entries.map((entry) => [
    entry.path, numeric(entry.maxFuncBranch), entry.nestingDepth, numeric(entry.loc), entry.alphaStruct,
    numeric(entry.connectedness), numeric(entry.externalPassthroughCalls),
  ]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))));

export const createStructuralCalibrationProfile = (input: {
  readonly analysisScopeFingerprint: string;
  readonly metricContractVersion: string;
  readonly p95: P95Values;
  readonly population: readonly CalibrationPopulationEntry[];
  readonly weights: CRLStateWeights;
}): StructuralCalibrationProfile => {
  const populationFingerprint = calibrationPopulationFingerprint(input.population);
  const weightsFingerprint = calibrationWeightsFingerprint(input.weights);
  const id = `${STRUCTURAL_CALIBRATION_VERSION}:${hash([input.analysisScopeFingerprint, input.metricContractVersion, populationFingerprint, weightsFingerprint])}`;
  return {
    id,
    version: STRUCTURAL_CALIBRATION_VERSION,
    source: "baseline",
    analysisScopeFingerprint: input.analysisScopeFingerprint,
    metricContractVersion: input.metricContractVersion,
    populationFingerprint,
    weightsFingerprint,
    p95: input.p95,
  };
};

/** Selects the profile that supplies gate denominators, with legacy fallback. */
export const gateCalibrationProfile = (state: StructuralCalibrationState | undefined): StructuralCalibrationProfile | undefined =>
  state?.gate ?? state?.current;

/**
 * Advances observed calibration on every structural change while retaining a
 * stable gate epoch. An old baseline without `gate` bootstraps from its last
 * observed profile, preserving the denominator that policy used before this
 * state field existed. Only an explicit seal moves the gate epoch.
 */
export const nextStructuralCalibrationState = (input: {
  readonly observed: StructuralCalibrationProfile;
  readonly previous?: StructuralCalibrationState;
  readonly sealGate?: boolean;
}): NextStructuralCalibrationState => {
  const observation = input.previous?.current.id === input.observed.id
    ? input.previous
    : {
      current: input.observed,
      ...(input.previous?.current ? { previous: input.previous.current } : {}),
      ...(input.previous?.gate ? { gate: input.previous.gate } : {}),
    };
  // For legacy state without `gate`, the pre-scan current profile is the
  // denominator policy actually used. Do not accidentally bootstrap from the
  // newly observed profile after a population change.
  const existingGate = input.previous?.gate ?? input.previous?.current ?? gateCalibrationProfile(observation);

  if (input.sealGate) {
    return { state: { ...observation, gate: input.observed }, transition: "sealed" };
  }
  if (observation.gate) return { state: observation, transition: "retained" };

  return {
    state: { ...observation, gate: existingGate ?? input.observed },
    transition: "bootstrapped",
  };
};

/** Scope, metric contract and normalisation weights must all agree before a change can be called denominator-only. */
export const comparableStructuralCalibration = (
  previous: StructuralCalibrationProfile | undefined,
  current: StructuralCalibrationProfile | undefined,
): boolean => previous !== undefined && current !== undefined
  && previous.analysisScopeFingerprint === current.analysisScopeFingerprint
  && previous.metricContractVersion === current.metricContractVersion
  && previous.weightsFingerprint === current.weightsFingerprint
  && previous.populationFingerprint !== current.populationFingerprint;
