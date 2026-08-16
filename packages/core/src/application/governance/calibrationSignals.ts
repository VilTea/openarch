import { computeCRLStateBreakdown, type CRLStateWeights } from "../../domain/crlState";
import { comparableStructuralCalibration, type StructuralCalibrationProfile } from "../../domain/calibration";
import type { IndexEntry } from "../../port/StorageService";
import { participatesInPopulation } from "../../domain/fileParticipation";

type CalibrationEntry = Pick<IndexEntry,
  "path" | "fileKind" | "maxFuncBranch" | "nestingDepth" | "loc" | "declarationLoc" | "alphaStruct" | "connectedness"
  | "externalPassthroughCalls" | "passthroughCalls" | "localBurdenFingerprint" | "previousLocalBurdenFingerprint">;

export interface CalibrationShiftCandidate {
  readonly path: string;
  readonly previousLocalBurden: number;
  readonly currentLocalBurden: number;
}

/**
 * Selects only unchanged local-burden inputs. Gate policy determines whether a
 * candidate actually crossed a project threshold; this function never judges it.
 */
export const calibrationShiftCandidates = (
  entries: readonly CalibrationEntry[],
  previous: StructuralCalibrationProfile | undefined,
  current: StructuralCalibrationProfile | undefined,
  weights: CRLStateWeights,
): readonly CalibrationShiftCandidate[] => {
  if (previous === undefined || current === undefined || !comparableStructuralCalibration(previous, current)) return [];
  return entries
    .filter((entry) => participatesInPopulation(entry.fileKind, "production-governance") && entry.localBurdenFingerprint !== undefined
      && entry.localBurdenFingerprint === entry.previousLocalBurdenFingerprint)
    .map((entry) => ({
      path: entry.path,
      previousLocalBurden: computeCRLStateBreakdown(entry, previous.p95, weights).localBurden,
      currentLocalBurden: computeCRLStateBreakdown(entry, current.p95, weights).localBurden,
    }))
    .filter((candidate) => candidate.previousLocalBurden !== candidate.currentLocalBurden);
};
