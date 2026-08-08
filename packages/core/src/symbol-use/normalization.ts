import type { SymbolUseFact } from "./types";

/** Provider-independent deduplication of declaration and reference evidence. */
export const normalizeSymbolUseFacts = (facts: readonly SymbolUseFact[]): readonly SymbolUseFact[] => {
  const byDeclaration = new Map<string, SymbolUseFact>();
  for (const fact of facts) {
    const key = `${fact.declaration.file}\0${fact.declaration.line}\0${fact.declaration.kind}\0${fact.declaration.name}`;
    const existing = byDeclaration.get(key);
    byDeclaration.set(key, existing ? {
      ...fact,
      repositoryReferences: [...new Map([...existing.repositoryReferences, ...fact.repositoryReferences]
        .map((reference) => [`${reference.file}:${reference.line}`, reference])).values()]
        .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line),
    } : fact);
  }
  return [...byDeclaration.values()].sort((left, right) =>
    left.declaration.file.localeCompare(right.declaration.file)
    || left.declaration.line - right.declaration.line
    || left.declaration.name.localeCompare(right.declaration.name));
};
