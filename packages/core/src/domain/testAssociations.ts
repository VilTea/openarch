import { resolve } from "node:path";
import type { ExportedSymbol, ImportRef } from "./ast";

export interface TestModuleAssociation {
  /** Resolved local production module. This says nothing about a symbol or runtime execution. */
  readonly targetPath: string;
  /** Original import specifier, retained as static evidence for local review. */
  readonly source: string;
  readonly confidence: "low" | "medium";
  /** Present only for medium evidence from a recognised test body. */
  readonly testName?: string;
  /** Present only for medium evidence; it is a resolved exported function, not coverage. */
  readonly symbol?: string;
}

/** Provider-observed direct call to a non-aliased named import inside a recognised test body. */
export interface TestSymbolCallEvidence {
  readonly testName: string;
  readonly source: string;
  readonly symbol: string;
}

const normalizePath = (path: string): string => resolve(path).replace(/\\/g, "/");

/**
 * S2's lowest evidence tier: a test file statically imports a resolved production module.
 * Importing a module does not prove a test calls or verifies any of its symbols.
 */
export const staticModuleAssociations = (
  imports: readonly ImportRef[],
  productionPaths: ReadonlySet<string>,
): readonly TestModuleAssociation[] => {
  const normalizedProductionPaths = new Set([...productionPaths].map(normalizePath));
  const byTarget = new Map<string, TestModuleAssociation>();
  for (const ref of imports) {
    if (ref.resolvedPath === null) continue;
    const targetPath = normalizePath(ref.resolvedPath);
    if (!normalizedProductionPaths.has(targetPath) || byTarget.has(targetPath)) continue;
    byTarget.set(targetPath, { targetPath, source: ref.source, confidence: "low" });
  }
  return [...byTarget.values()].sort((a, b) => a.targetPath.localeCompare(b.targetPath));
};

/**
 * Promotes only a unique local module import whose target parser confirms the called exported function.
 * It intentionally cannot infer aliases, overloaded package exports, indirect calls, or runtime execution.
 */
export const promoteStaticModuleAssociations = (
  associations: readonly TestModuleAssociation[],
  calls: readonly TestSymbolCallEvidence[],
  exportedSymbolsByPath: ReadonlyMap<string, readonly ExportedSymbol[] | undefined>,
): readonly TestModuleAssociation[] => {
  const promoted: TestModuleAssociation[] = [];
  const promotedTargets = new Set<string>();
  for (const call of calls) {
    const candidates = associations.filter((association) => association.source === call.source);
    if (candidates.length !== 1) continue;
    const candidate = candidates[0];
    const exports = exportedSymbolsByPath.get(candidate.targetPath);
    if (!exports?.some((symbol) => symbol.kind === "function" && symbol.name === call.symbol)) continue;
    promoted.push({ ...candidate, confidence: "medium", testName: call.testName, symbol: call.symbol });
    promotedTargets.add(candidate.targetPath);
  }
  return [
    ...associations.filter((association) => !promotedTargets.has(association.targetPath)),
    ...promoted,
  ].sort((a, b) => a.targetPath.localeCompare(b.targetPath) || (a.testName ?? "").localeCompare(b.testName ?? ""));
};
