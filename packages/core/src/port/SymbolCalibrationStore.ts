import { Context, Effect } from "effect";
import type { IoError } from "../errors/errors";
import type { SymbolCalibrationProfile } from "../domain/symbolCalibration";

/** Durable historical evidence is separate from structural baseline/history. */
export interface SymbolCalibrationStore {
  readonly writeProfile: (profile: SymbolCalibrationProfile) => Effect.Effect<void, IoError>;
  readonly readProfile: (profileId: string) => Effect.Effect<SymbolCalibrationProfile | null, IoError>;
  readonly listProfiles: () => Effect.Effect<readonly SymbolCalibrationProfile[], IoError>;
}

export const SymbolCalibrationStore = Context.GenericTag<SymbolCalibrationStore>("SymbolCalibrationStore");
