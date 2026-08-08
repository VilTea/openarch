import type { Node } from "web-tree-sitter";
import type { SemanticDeclaration, SemanticDeclarationKind, SemanticSurface } from "../../domain/ast";

export interface DeclarationSyntax {
  readonly isImport: (node: Node) => boolean;
  readonly isIgnored: (node: Node) => boolean;
  readonly isWrapper: (node: Node) => boolean;
  readonly kindOf: (node: Node) => SemanticDeclarationKind | undefined;
  readonly nameOf: (node: Node) => string | undefined;
  readonly isPublic: (node: Node, inherited: boolean) => boolean;
  readonly contractCompatibilityOf?: (node: Node) => SemanticDeclaration["contractCompatibility"];
  readonly isReExport?: (node: Node) => boolean;
  readonly bodyOf: (node: Node) => Node | undefined;
}

const compact = (text: string): string => text.replace(/\s+/g, " ").trim();

const declarationFrom = (
  node: Node,
  kind: SemanticDeclarationKind,
  id: string,
  isPublic: boolean,
  contractCompatibility: SemanticDeclaration["contractCompatibility"],
  isReExport: boolean,
  body: Node | undefined,
): SemanticDeclaration => ({
  id,
  kind,
  isPublic,
  ...(contractCompatibility ? { contractCompatibility } : {}),
  ...(isReExport ? { provenance: "reexport" as const } : {}),
  signature: compact(body ? node.text.slice(0, Math.max(0, body.startIndex - node.startIndex)) : node.text),
  ...(body ? { body: compact(body.text) } : {}),
});

/**
 * Traverses only declaration-bearing syntax. Language strategies supply node
 * names and visibility semantics; the traversal and stable member identities
 * remain shared so a new language cannot grow a parallel diff engine.
 */
export const collectSemanticSurface = (root: Node, syntax: DeclarationSyntax): SemanticSurface => {
  const declarations: SemanticDeclaration[] = [];
  const unsupportedTopLevel: string[] = [];

  const visit = (node: Node, scope: readonly string[], inheritedPublic: boolean, topLevel: boolean): void => {
    if (syntax.isIgnored(node)) return;
    if (syntax.isImport(node)) return;
    if (syntax.isWrapper(node)) {
      if (node.namedChildren.length === 0 && topLevel) unsupportedTopLevel.push(`${node.type}:${compact(node.text)}`);
      for (const child of node.namedChildren) visit(child, scope, true, topLevel);
      return;
    }
    const kind = syntax.kindOf(node);
    if (!kind) {
      if (topLevel && node.type !== "comment") unsupportedTopLevel.push(`${node.type}:${compact(node.text)}`);
      return;
    }
    const name = syntax.nameOf(node);
    if (!name) {
      if (topLevel) unsupportedTopLevel.push(`${node.type}:${compact(node.text)}`);
      return;
    }
    const body = syntax.bodyOf(node);
    const id = [...scope, name].join(".");
    const publicDeclaration = syntax.isPublic(node, inheritedPublic);
    declarations.push(declarationFrom(
      node, kind, id, publicDeclaration, syntax.contractCompatibilityOf?.(node), syntax.isReExport?.(node) ?? false, body,
    ));

    if (kind === "interface" || kind === "class") {
      for (const child of body?.namedChildren ?? []) visit(child, [...scope, name], publicDeclaration, false);
    }
  };

  for (const child of root.namedChildren) visit(child, [], false, true);
  return { declarations, unsupportedTopLevel };
};
