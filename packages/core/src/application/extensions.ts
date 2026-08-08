import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isAntiPatternRule } from "../anti-patterns/engine";
import { implicitDepsRulesDir, antiPatternRulesDir, testGovernanceRulesDir } from "../infra/paths";
import { isImplicitDependencyRule } from "../implicit-deps/engine";
import { loadDefaultExport, type ScriptImport } from "../script-runtime/loadDefaultExport";
import { isTestFindingScript } from "../test-governance/engine";
import { scriptFactRequirementsError } from "../script-runtime/projectFacts";
import { defaultScriptIdForPath } from "./defaultScripts";

export type ExtensionEngine = "anti-patterns" | "implicit-deps" | "test-governance";

export interface ExtensionContractIssue {
  readonly engine: ExtensionEngine;
  readonly path: string;
  readonly error: string;
}

export interface ExtensionContractReport {
  readonly checked: number;
  readonly byEngine: Readonly<Record<ExtensionEngine, number>>;
  readonly issues: readonly ExtensionContractIssue[];
}

export interface ExtensionContractOptions {
  readonly directories?: Partial<Record<ExtensionEngine, string>>;
  readonly importFn?: ScriptImport;
}

const defaultDirectories = (): Record<ExtensionEngine, string> => ({
  "anti-patterns": antiPatternRulesDir(),
  "implicit-deps": implicitDepsRulesDir(),
  "test-governance": testGovernanceRulesDir(),
});

const contractError = (engine: ExtensionEngine): string => {
  if (engine === "anti-patterns") return "必须 export default；file/repository 规则导出 { scope, stages, link }；change_set 规则导出 { scope, detect }";
  return "必须 export default { stages, link }";
};

const validates = (engine: ExtensionEngine, value: unknown): boolean => {
  if (engine === "anti-patterns") return isAntiPatternRule(value);
  if (engine === "implicit-deps") return isImplicitDependencyRule(value);
  return isTestFindingScript(value);
};

/**
 * Checks project-owned extension modules without executing link callbacks or project scans.
 * It is a contract preflight before an agent calibrates a new defensive rule.
 */
export const checkExtensionContracts = async (options: ExtensionContractOptions = {}): Promise<ExtensionContractReport> => {
  const directories = { ...defaultDirectories(), ...options.directories };
  const byEngine: Record<ExtensionEngine, number> = {
    "anti-patterns": 0,
    "implicit-deps": 0,
    "test-governance": 0,
  };
  const issues: ExtensionContractIssue[] = [];

  for (const engine of Object.keys(directories) as ExtensionEngine[]) {
    const directory = directories[engine];
    if (!directory || !existsSync(directory)) continue;
    const files = readdirSync(directory).filter((file) => file.endsWith(".mjs")).sort();
    for (const file of files) {
      const path = join(directory, file);
      byEngine[engine] += 1;
      const loaded = await loadDefaultExport(path, options.importFn);
      if (loaded.error) {
        issues.push({ engine, path, error: loaded.error });
      } else {
        const requires = loaded.value && typeof loaded.value === "object"
          ? (loaded.value as Record<string, unknown>).requires
          : undefined;
        const requirementError = scriptFactRequirementsError(requires);
        if (requirementError) {
          issues.push({ engine, path, error: requirementError });
        } else if (!validates(engine, loaded.value)) {
          const defaultAsset = defaultScriptIdForPath(path);
          const migration = defaultAsset ? `；默认资产可显式替换: openarch init --replace-script ${defaultAsset}` : "";
          issues.push({ engine, path, error: `${contractError(engine)}${migration}` });
        }
      }
    }
  }

  return { checked: Object.values(byEngine).reduce((total, count) => total + count, 0), byEngine, issues };
};
