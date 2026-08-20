import type { FileAst, SemanticDeclaration } from "./ast";
import type { ChangeKind } from "./weights";

export interface SemanticChange {
  readonly anchor: string;
  readonly kind: ChangeKind;
}

export type SemanticChangeAnalysis =
  | { readonly availability: "available"; readonly changes: readonly SemanticChange[] }
  | { readonly availability: "unavailable"; readonly changes: readonly []; readonly reason: string };

const same = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/** TypeScript and similar languages may legally expose a type and value with one name. */
const declarationKey = (declaration: SemanticDeclaration): string => `${declaration.id}\u0000${declaration.kind}`;

const declarationMap = (declarations: readonly SemanticDeclaration[]): Map<string, SemanticDeclaration> | undefined => {
  const byId = new Map<string, SemanticDeclaration>();
  for (const declaration of declarations) {
    const key = declarationKey(declaration);
    if (byId.has(key)) return undefined;
    byId.set(key, declaration);
  }
  return byId;
};

const declarationKind = (declaration: SemanticDeclaration, operation: "add" | "remove"): ChangeKind => {
  if (!declaration.isPublic) return declaration.kind === "function" ? "function_sig" : "function_body";
  if (operation === "add" && declaration.contractCompatibility === "additive") return "compatible_field_add";
  if (declaration.kind === "interface") return "interface_add_remove";
  if (declaration.kind === "class") return "class_add_remove";
  if (declaration.kind === "field") return "field_add_remove";
  return "public_method_sig";
};

const signatureKind = (before: SemanticDeclaration, after: SemanticDeclaration): ChangeKind => {
  const isPublic = before.isPublic || after.isPublic;
  if (!isPublic) return before.kind === "function" || after.kind === "function" ? "function_sig" : "function_body";
  if (before.kind === "interface" || after.kind === "interface") return "interface_add_remove";
  if (before.kind === "class" || after.kind === "class") return "class_add_remove";
  if (before.kind === "field" || after.kind === "field") return "field_add_remove";
  return "public_method_sig";
};

const hasAncestor = (declaration: SemanticDeclaration, candidates: ReadonlySet<string>): boolean => {
  const id = declaration.id;
  const segments = id.split(".");
  while (segments.length > 1) {
    segments.pop();
    const ancestor = segments.join(".");
    if ([...candidates].some((candidate) => candidate.startsWith(`${ancestor}\u0000`))) return true;
  }
  return false;
};

const importSources = (ast: FileAst): readonly string[] => [...new Set(ast.imports.map((entry) => entry.source))].sort();

interface DeclarationMaps {
  readonly before: ReadonlyMap<string, SemanticDeclaration>;
  readonly after: ReadonlyMap<string, SemanticDeclaration>;
  /** True when the parser reports changed top-level syntax that has no declaration classifier. */
  readonly unsupportedTopLevelChanged: boolean;
}

const byUniqueId = (declarations: Iterable<SemanticDeclaration>): ReadonlyMap<string, SemanticDeclaration | undefined> => {
  const result = new Map<string, SemanticDeclaration | undefined>();
  for (const declaration of declarations) {
    if (result.has(declaration.id)) result.set(declaration.id, undefined);
    else result.set(declaration.id, declaration);
  }
  return result;
};

/** A stable exported name can move from a local definition to a re-export. */
const normalizeReexportIdentity = (
  declarations: Iterable<SemanticDeclaration>,
  counterparts: ReadonlyMap<string, SemanticDeclaration | undefined>,
): readonly SemanticDeclaration[] => [...declarations].map((declaration) => {
  const counterpart = counterparts.get(declaration.id);
  return declaration.provenance === "reexport" && counterpart
    ? { ...declaration, kind: counterpart.kind, signature: counterpart.signature, ...(counterpart.body ? { body: counterpart.body } : {}) }
    : declaration;
});

const mapsFor = (before: FileAst | undefined, after: FileAst | undefined): DeclarationMaps | string => {
  if (!before && !after) return "revision has no readable source";
  const beforeSurface = before?.semanticSurface;
  const afterSurface = after?.semanticSurface;
  if ((before && !beforeSurface) || (after && !afterSurface)) return "language parser does not provide declaration facts";
  const rawBefore = beforeSurface?.declarations ?? [];
  const rawAfter = afterSurface?.declarations ?? [];
  const beforeDeclarations = declarationMap(normalizeReexportIdentity(rawBefore, byUniqueId(rawAfter)));
  const afterDeclarations = declarationMap(normalizeReexportIdentity(rawAfter, byUniqueId(rawBefore)));
  if (!beforeDeclarations || !afterDeclarations) return "declaration identities are ambiguous";
  return {
    before: beforeDeclarations,
    after: afterDeclarations,
    unsupportedTopLevelChanged: !!(beforeSurface && afterSurface && !same(beforeSurface.unsupportedTopLevel, afterSurface.unsupportedTopLevel)),
  };
};

const addedOrRemovedChanges = (
  declarations: ReadonlyMap<string, SemanticDeclaration>,
  missingFrom: ReadonlyMap<string, SemanticDeclaration>,
  operation: "add" | "remove",
): readonly SemanticChange[] => {
  const changed = new Set([...declarations.keys()].filter((id) => !missingFrom.has(id)));
  return [...declarations].flatMap(([id, declaration]) =>
    changed.has(id) && !hasAncestor(declaration, changed) ? [{ anchor: declaration.id, kind: declarationKind(declaration, operation) }] : []
  );
};

const changedDeclarationUnits = (before: ReadonlyMap<string, SemanticDeclaration>, after: ReadonlyMap<string, SemanticDeclaration>): readonly SemanticChange[] =>
  [...before].flatMap(([id, beforeDeclaration]) => {
    const afterDeclaration = after.get(id);
    if (!afterDeclaration) return [];
    if (beforeDeclaration.kind !== afterDeclaration.kind || beforeDeclaration.signature !== afterDeclaration.signature || beforeDeclaration.isPublic !== afterDeclaration.isPublic) {
      return [{ anchor: beforeDeclaration.id, kind: signatureKind(beforeDeclaration, afterDeclaration) }];
    }
    return beforeDeclaration.kind === "function" && beforeDeclaration.body !== afterDeclaration.body
      ? [{ anchor: beforeDeclaration.id, kind: "function_body" }]
      : [];
  });

const importChanges = (before: FileAst | undefined, after: FileAst | undefined): readonly SemanticChange[] => {
  const beforeImports = new Set(before ? importSources(before) : []);
  const afterImports = new Set(after ? importSources(after) : []);
  return [
    ...[...afterImports].filter((source) => !beforeImports.has(source)).map((source) => ({ anchor: `import:${source}`, kind: "dependency_add" as const })),
    ...[...beforeImports].filter((source) => !afterImports.has(source)).map((source) => ({ anchor: `import:${source}`, kind: "dependency_remove" as const })),
  ];
};

/**
 * Pure, conservative declaration-level change classifier. It only falls back
 * to `function_body` for changed top-level syntax when there are no other
 * declaration/import units to classify; it never invents public contract
 * changes from unclassified syntax.
 */
export const analyzeSemanticChanges = (before: FileAst | undefined, after: FileAst | undefined): SemanticChangeAnalysis => {
  const maps = mapsFor(before, after);
  if (typeof maps === "string") return { availability: "unavailable", changes: [], reason: maps };
  const changes = [
    ...addedOrRemovedChanges(maps.after, maps.before, "add"),
    ...addedOrRemovedChanges(maps.before, maps.after, "remove"),
    ...changedDeclarationUnits(maps.before, maps.after),
    ...importChanges(before, after),
  ];
  if (changes.length > 0) return { availability: "available", changes };
  if (maps.unsupportedTopLevelChanged) {
    return { availability: "available", changes: [{ anchor: "file:top-level", kind: "function_body" }] };
  }
  return { availability: "available", changes: [{ anchor: "file", kind: "comment_whitespace" }] };
};
