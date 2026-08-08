import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TOOLCHAIN_CONFIG_TEMPLATE, projectToolchainConfigPath, userToolchainConfigPath, type ToolchainConfigScope } from "../toolchain/config";
import { ensureToolchainConfigExcluded } from "./governancePersistence";

export interface ToolchainConfigSetupInput {
  readonly cwd: string;
  readonly scope: ToolchainConfigScope;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
}

export type ToolchainConfigSetupResult =
  | { readonly path: string; readonly created: boolean; readonly exclude: "updated" | "unchanged" | "unavailable" }
  | { readonly error: string };

/** Creates an empty local configuration without writing machine paths into project governance config. */
export const initializeToolchainConfig = async (input: ToolchainConfigSetupInput): Promise<ToolchainConfigSetupResult> => {
  const runtime = { platform: input.platform ?? process.platform, environment: input.environment ?? process.env };
  const path = input.scope === "user" ? userToolchainConfigPath(runtime) : projectToolchainConfigPath(input.cwd);
  if (!path) return { error: "cannot determine user configuration directory; set HOME, APPDATA, or OPENARCH_TOOLCHAINS_FILE" };
  if (existsSync(path)) return { path, created: false, exclude: input.scope === "project" ? await ensureToolchainConfigExcluded(input.cwd) : "unchanged" };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, TOOLCHAIN_CONFIG_TEMPLATE);
    return { path, created: true, exclude: input.scope === "project" ? await ensureToolchainConfigExcluded(input.cwd) : "unchanged" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};
