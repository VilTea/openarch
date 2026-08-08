import { Effect } from "effect";
import {
  buildSymbolCalibrationProfile,
  createSymbolCalibrationSample,
  type SymbolCalibrationExpectation,
  type SymbolCalibrationProfile,
} from "../domain/symbolCalibration";
import type { SymbolVersionPairReport } from "../domain/symbolVersionPair";
import { SymbolCalibrationStore } from "../port/SymbolCalibrationStore";
import type { IoError } from "../errors/errors";

export interface SymbolCalibrationObservationInput {
  readonly report: SymbolVersionPairReport;
  readonly id: string;
  readonly identity: string;
  readonly expected: SymbolCalibrationExpectation;
}

/** Records explicit version-pair observations without changing metric or policy state. */
export const recordSymbolCalibrationProfile = (
  observations: readonly SymbolCalibrationObservationInput[],
): Effect.Effect<SymbolCalibrationProfile, IoError, SymbolCalibrationStore> => Effect.gen(function* () {
  const store = yield* SymbolCalibrationStore;
  const profile = buildSymbolCalibrationProfile(observations.map(({ report, ...input }) => createSymbolCalibrationSample(report, input)));
  yield* store.writeProfile(profile);
  return profile;
});

export const loadSymbolCalibrationProfiles = (): Effect.Effect<readonly SymbolCalibrationProfile[], IoError, SymbolCalibrationStore> => Effect.gen(function* () {
  const store = yield* SymbolCalibrationStore;
  return yield* store.listProfiles();
});
