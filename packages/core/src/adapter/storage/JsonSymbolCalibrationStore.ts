import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { IoError } from "../../errors/errors";
import { parseSymbolCalibrationProfile, type SymbolCalibrationProfile } from "../../domain/symbolCalibration";
import type { SymbolCalibrationStore } from "../../port/SymbolCalibrationStore";
import { atomicWriteJsonIfChanged } from "./AtomicWriter";

const fileNameFor = (profileId: string): string => `${createHash("sha256").update(profileId).digest("hex")}.json`;

/** Content-addressed, source-free symbol calibration profiles. */
export const createJsonSymbolCalibrationStore = (rootDir: () => string): SymbolCalibrationStore => {
  const directory = () => join(rootDir(), "calibration", "symbol");
  const pathFor = (profileId: string): string => join(directory(), fileNameFor(profileId));
  const read = (path: string): SymbolCalibrationProfile => parseSymbolCalibrationProfile(JSON.parse(readFileSync(path, "utf8")));

  return {
    writeProfile: (profile) => Effect.tryPromise({
      try: async () => {
        const validated = parseSymbolCalibrationProfile(profile);
        const target = pathFor(validated.id);
        mkdirSync(directory(), { recursive: true });
        await atomicWriteJsonIfChanged(target, validated);
      },
      catch: (error) => new IoError({ path: pathFor(profile.id), cause: error }),
    }),
    readProfile: (profileId) => Effect.try({
      try: () => {
        const path = pathFor(profileId);
        return existsSync(path) ? (() => {
          const profile = read(path);
          return profile.id === profileId ? profile : null;
        })() : null;
      },
      catch: (error) => new IoError({ path: pathFor(profileId), cause: error }),
    }),
    listProfiles: () => Effect.try({
      try: () => {
        const root = directory();
        if (!existsSync(root)) return [];
        return readdirSync(root)
          .filter((name) => name.endsWith(".json"))
          .sort()
          .map((name) => read(join(root, name)));
      },
      catch: (error) => new IoError({ path: directory(), cause: error }),
    }),
  };
};
