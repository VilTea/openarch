import { Effect } from "effect";
import {
  evaluateSymbolScopeShadowEvidence,
  type SymbolScopeHistoricalStructuralInput,
  type SymbolScopeShadowEvidenceReport,
} from "../domain/symbolScopeShadowEvidence";
import type { SymbolVersionPairReport } from "../domain/symbolVersionPair";
import { SymbolCalibrationStore } from "../port/SymbolCalibrationStore";
import type { IoError } from "../errors/errors";

/**
 * Loads durable calibration profiles and evaluates one explicit Git version-pair.
 * This capability-specific read path intentionally does not widen StorageService.
 */
export const evaluatePersistedSymbolScopeShadowEvidence = (input: {
  readonly report: SymbolVersionPairReport;
  readonly structuralInputs: readonly SymbolScopeHistoricalStructuralInput[];
}): Effect.Effect<SymbolScopeShadowEvidenceReport, IoError, SymbolCalibrationStore> => Effect.gen(function* () {
  const store = yield* SymbolCalibrationStore;
  const calibrationProfiles = yield* store.listProfiles();
  return evaluateSymbolScopeShadowEvidence({ ...input, calibrationProfiles });
});
