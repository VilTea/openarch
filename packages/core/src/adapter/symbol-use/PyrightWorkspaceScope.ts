import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";

type PyrightWorkspaceConfig = Readonly<Record<string, unknown>>;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;

const scopeRisk = (config: PyrightWorkspaceConfig): readonly string[] =>
  Array.isArray(config.executionEnvironments) || Array.isArray(config.extraPaths)
    ? ["Pyright execution-environment or extra-path configuration is outside the calibrated reference scope"]
    : [];

/** Reads only the two Pyright configuration forms that can widen import resolution. */
export const pyrightWorkspaceRisks = ({ cwd }: { readonly cwd: string }): readonly string[] => {
  const jsonConfig = join(cwd, "pyrightconfig.json");
  if (existsSync(jsonConfig)) {
    try {
      return scopeRisk(asRecord(JSON.parse(readFileSync(jsonConfig, "utf8"))) ?? {});
    } catch {
      return ["Pyright workspace configuration could not be read"];
    }
  }

  const pyproject = join(cwd, "pyproject.toml");
  if (!existsSync(pyproject)) return [];
  try {
    const project = asRecord(parse(readFileSync(pyproject, "utf8")));
    const tool = asRecord(project?.tool);
    const pyright = asRecord(tool?.pyright);
    return pyright ? scopeRisk(pyright) : [];
  } catch {
    return ["Pyright pyproject.toml configuration could not be read"];
  }
};
