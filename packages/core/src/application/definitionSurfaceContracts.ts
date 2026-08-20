// Definition-surface contract layer (report-only enforcement candidates).
// A contract declares a role file family and the shared authority module it
// must import. The fact layer recalls "these files look similar"; this layer
// says whether a declared contract is being bypassed.
//
// This module is intentionally project-agnostic. Callers pass project-declared
// contracts (from a project script, configuration, or programmatic API); core
// never hard-codes a specific project's file names or module names.
import { readFileSync } from "node:fs";
import { minimatch } from "minimatch";
import { normalizeRepositoryPath } from "../script-runtime/projectFacts";

export interface DefinitionSurfaceContract {
  readonly id: string;
  readonly description: string;
  readonly roleGlobs: readonly string[];
  readonly authorityGlobs: readonly string[];
  /** Module specifier that role files must import from the authority. */
  readonly requiredImport: string;
}

export interface DefinitionSurfaceContractFinding {
  readonly contractId: string;
  readonly file: string;
  readonly message: string;
  readonly authorityPath: string;
}

const matchesAny = (path: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => minimatch(path, pattern, { dot: true }));

/** Checks declared definition-surface contracts. Files that cannot be read are
 *  skipped, not treated as compliant. A contract only applies when at least one
 *  authority file matching `authorityGlobs` exists in the project. */
export const assessDefinitionSurfaceContracts = (
  cwd: string,
  files: readonly string[],
  contracts: readonly DefinitionSurfaceContract[],
): readonly DefinitionSurfaceContractFinding[] => {
  const entries = files.map((file) => ({ file, repositoryPath: normalizeRepositoryPath(file, cwd) }));
  const findings: DefinitionSurfaceContractFinding[] = [];
  for (const contract of contracts) {
    const authority = entries.find((entry) => matchesAny(entry.repositoryPath, contract.authorityGlobs));
    // Without an authority there is no "should converge to" target.
    if (!authority) continue;
    const authorityPath = authority.repositoryPath;
    const escapedImport = contract.requiredImport.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const importPattern = new RegExp(`(?:from\\s*['"]${escapedImport}['"]|require\\s*\\(\\s*['"]${escapedImport}['"]\\s*\\))`);
    for (const entry of entries) {
      if (!matchesAny(entry.repositoryPath, contract.roleGlobs)) continue;
      if (entry.repositoryPath === authority.repositoryPath) continue;
      let source: string;
      try {
        source = readFileSync(entry.file, "utf8");
      } catch {
        continue;
      }
      if (importPattern.test(source)) continue;
      findings.push({
        contractId: contract.id,
        file: entry.repositoryPath,
        message: `未接入共享模块 ${contract.requiredImport}；疑似平行实现`,
        authorityPath,
      });
    }
  }
  return findings;
};
