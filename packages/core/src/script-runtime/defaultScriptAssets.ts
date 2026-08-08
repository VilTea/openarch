import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeResourcePath } from "../runtimeAssets";

export type DefaultScriptAssetKind = "script" | "parameterized-template" | "provider" | "runner" | "configuration-template" | "starter";

export interface DefaultScriptAsset {
  readonly id: string;
  /** Stable semantic family across language-specific implementations. */
  readonly patternFamily?: string;
  readonly languages?: readonly string[];
  readonly source?: string;
  readonly target?: string;
  readonly engine?: string;
  readonly runtimeId?: string;
  readonly starterId?: string;
  readonly summary?: string;
  readonly kind: DefaultScriptAssetKind;
}

interface DefaultScriptAssetManifest {
  readonly entries: readonly (Omit<DefaultScriptAsset, "starterId" | "runtimeId" | "patternFamily"> & {
    readonly starter_id?: string;
    readonly runtime_id?: string;
    readonly pattern_family?: string;
  })[];
}

/** Package-owned assets work from source, npm packages and binary resource bundles. */
const templateRoot = runtimeResourcePath("assets", "templates");

/** The packaged manifest is the sole catalogue for installable scripts and public starters. */
export const defaultScriptAssets = (): readonly DefaultScriptAsset[] =>
  (JSON.parse(readFileSync(join(templateRoot, "default-scripts.json"), "utf8")) as DefaultScriptAssetManifest).entries
    .map(({ starter_id, runtime_id, pattern_family, ...asset }) => ({
      ...asset,
      ...(starter_id ? { starterId: starter_id } : {}),
      ...(runtime_id ? { runtimeId: runtime_id } : {}),
      ...(pattern_family ? { patternFamily: pattern_family } : {}),
    }));

/** Manifest-backed recommendations only; installation and policy stay project-explicit. */
export const recommendedAntiPatternAssets = (languages: readonly string[]): readonly DefaultScriptAsset[] =>
  defaultScriptAssets().filter((asset) =>
    asset.kind === "script"
    && asset.engine === "anti-patterns"
    && !!asset.patternFamily
    && !!asset.languages
    && (asset.languages.includes("*") || asset.languages.some((language) => languages.includes(language))),
  );

export const readDefaultScriptAsset = (asset: DefaultScriptAsset): string | undefined =>
  asset.source ? readFileSync(join(templateRoot, asset.source), "utf8") : undefined;
