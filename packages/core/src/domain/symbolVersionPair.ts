import { createHash } from "node:crypto";
import type { Language } from "./ast";
import type { SymbolUseFact, SymbolUseReport } from "../symbol-use/types";

export type SymbolRevisionAvailability = "available" | "partial" | "unavailable";

/**
 * A bounded, read-only Git revision population. It is deliberately separate
 * from SymbolUseDemand: a demand asks a provider a narrow question, while a
 * snapshot records where versioned evidence came from.
 */
export interface SymbolRevisionSnapshot {
  readonly revision: string;
  readonly origin: "git";
  readonly availability: SymbolRevisionAvailability;
  readonly population: {
    readonly files: readonly string[];
    readonly fingerprint: string;
  };
  /** Ephemeral source texts used only while a provider evaluates this snapshot. */
  readonly texts: ReadonlyMap<string, string>;
  readonly supportTexts: ReadonlyMap<string, string>;
  readonly reason?: string;
}

export interface SymbolVersionedPopulation {
  readonly beforeRevision: string;
  readonly afterRevision: string;
  /** Files present in both governed revision populations, never an inferred project layout. */
  readonly files: readonly string[];
  readonly fingerprint: string;
}

export type SymbolDeclarationPairStatus = "matched" | "added" | "removed" | "ambiguous";

export interface SymbolDeclarationPair {
  readonly identity: string;
  readonly status: SymbolDeclarationPairStatus;
  readonly before?: SymbolUseFact;
  readonly after?: SymbolUseFact;
  readonly reason?: string;
}

export interface SymbolVersionPairReport {
  readonly language: Language;
  readonly availability: SymbolRevisionAvailability;
  readonly population: SymbolVersionedPopulation;
  readonly before?: SymbolUseReport;
  readonly after?: SymbolUseReport;
  readonly declarations: readonly SymbolDeclarationPair[];
  readonly reason?: string;
}

/**
 * Deliberately excludes line numbers: edits commonly move declarations.
 * Duplicate compiler facts for the same semantic shape (for example overloads)
 * must remain ambiguous rather than silently becoming a false version match.
 */
export const symbolVersionDeclarationIdentity = (fact: SymbolUseFact): string =>
  `${fact.language}\0${fact.declaration.file}\0${fact.declaration.kind}\0${fact.declaration.name}`;

const grouped = (facts: readonly SymbolUseFact[]): ReadonlyMap<string, readonly SymbolUseFact[]> => {
  const result = new Map<string, SymbolUseFact[]>();
  for (const fact of facts) {
    const identity = symbolVersionDeclarationIdentity(fact);
    result.set(identity, [...(result.get(identity) ?? []), fact]);
  }
  return result;
};

/** Pairs only unique, explicit identities; rename/move inference belongs to a future calibrated contract. */
export const pairVersionedSymbolDeclarations = (
  before: readonly SymbolUseFact[],
  after: readonly SymbolUseFact[],
): readonly SymbolDeclarationPair[] => {
  const beforeByIdentity = grouped(before);
  const afterByIdentity = grouped(after);
  const identities = [...new Set([...beforeByIdentity.keys(), ...afterByIdentity.keys()])].sort();
  return identities.map((identity): SymbolDeclarationPair => {
    const beforeFacts = beforeByIdentity.get(identity) ?? [];
    const afterFacts = afterByIdentity.get(identity) ?? [];
    if (beforeFacts.length > 1 || afterFacts.length > 1) {
      return { identity, status: "ambiguous", reason: "multiple declarations share the stable version identity" };
    }
    if (beforeFacts.length === 0) return { identity, status: "added", after: afterFacts[0]! };
    if (afterFacts.length === 0) return { identity, status: "removed", before: beforeFacts[0]! };
    return { identity, status: "matched", before: beforeFacts[0]!, after: afterFacts[0]! };
  });
};

export const commonSymbolVersionedPopulation = (
  beforeRevision: string,
  beforeFiles: readonly string[],
  afterRevision: string,
  afterFiles: readonly string[],
): SymbolVersionedPopulation => {
  const after = new Set(afterFiles);
  const files = [...new Set(beforeFiles)].filter((file) => after.has(file)).sort();
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ definition: "symbol-version-population", beforeRevision, afterRevision, files }))
    .digest("hex");
  return { beforeRevision, afterRevision, files, fingerprint };
};
