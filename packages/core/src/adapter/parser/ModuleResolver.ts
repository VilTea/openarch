import type { ImportRef } from "../../domain/ast";
import type { ImportSource } from "./ImportExtraction";

/** Language module semantics resolve raw import specifiers after AST extraction. */
export interface ModuleResolver {
  readonly resolveLocal: (importerPath: string, source: string) => readonly string[];
}

/** Keeps unresolved and external specifiers explicit without inventing graph edges. */
export const resolveImportRefs = (
  importerPath: string,
  sources: readonly ImportSource[],
  resolver: ModuleResolver,
): readonly ImportRef[] => sources.flatMap<ImportRef>(({ source, relation }): readonly ImportRef[] => {
  const resolvedPaths = resolver.resolveLocal(importerPath, source);
  return resolvedPaths.length === 0
    ? [{ source, resolvedPath: null, ...(relation ? { relation } : {}) }]
    : resolvedPaths.map((resolvedPath) => ({ source, resolvedPath, ...(relation ? { relation } : {}) }));
});
