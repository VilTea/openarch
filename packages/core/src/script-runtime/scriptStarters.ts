import { defaultScriptAssets, readDefaultScriptAsset } from "./defaultScriptAssets";

export type ScriptStarterId = string;

export interface ScriptStarter {
  readonly id: ScriptStarterId;
  readonly summary: string;
  readonly source: string;
}

/** Public starter output is projected from the packaged manifest, never duplicated in TypeScript. */
export const SCRIPT_STARTERS: readonly ScriptStarter[] = Object.freeze(
  defaultScriptAssets().flatMap((asset) => {
    if (asset.kind !== "starter" || !asset.starterId || !asset.summary) return [];
    const source = readDefaultScriptAsset(asset);
    return source === undefined ? [] : [{ id: asset.starterId, summary: asset.summary, source }];
  }),
);

export const scriptStarter = (id: string): ScriptStarter | undefined =>
  SCRIPT_STARTERS.find((starter) => starter.id === id);
