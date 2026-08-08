import type { Node } from "web-tree-sitter";

/** Grammar-specific syntax facts needed before module resolution. */
export interface ImportSyntax {
  readonly isImportNode: (node: Node) => boolean;
  readonly sourceFromNode: (node: Node) => string | null;
  /** Only set this when the grammar proves that a module is publicly forwarded. */
  readonly isReexportNode?: (node: Node) => boolean;
}

/** Traverses syntax once; strategies provide only their grammar-specific import shape. */
export interface ImportSource {
  readonly source: string;
  readonly relation?: "reexport";
}

export const collectImportSources = (root: Node, syntax: ImportSyntax): readonly ImportSource[] => {
  const sources: ImportSource[] = [];
  const visit = (node: Node): void => {
    if (syntax.isImportNode(node)) {
      const source = syntax.sourceFromNode(node);
      if (source) sources.push({ source, ...(syntax.isReexportNode?.(node) ? { relation: "reexport" } : {}) });
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return sources;
};
