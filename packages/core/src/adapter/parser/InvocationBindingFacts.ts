import type { Node } from "web-tree-sitter";
import type { InvocationBindingFact } from "../../domain/invocationBindings";

export type BindingEvidence = InvocationBindingFact["evidence"];
export interface LexicalBinding { readonly target: string; readonly evidence: BindingEvidence; }
export type BindingMap = ReadonlyMap<string, LexicalBinding>;

export interface InvocationBindingSemantics {
  readonly scopeTypes: ReadonlySet<string>;
  readonly bindingsForNode: (node: Node, bindings: BindingMap) => readonly { readonly name: string; readonly binding: LexicalBinding }[];
  readonly callForNode: (node: Node, bindings: BindingMap) => { readonly receiver: string; readonly method: string; readonly binding: LexicalBinding } | undefined;
}

/** Shared lexical traversal; language strategies supply only AST-node semantics, never source-text parsers. */
export const collectInvocationBindings = (
  filePath: string,
  root: Node,
  semantics: InvocationBindingSemantics,
): readonly InvocationBindingFact[] => {
  const result: InvocationBindingFact[] = [];
  const visit = (node: Node, inherited: BindingMap): void => {
    const bindings = semantics.scopeTypes.has(node.type) ? new Map(inherited) : inherited as Map<string, LexicalBinding>;
    for (const entry of semantics.bindingsForNode(node, bindings)) bindings.set(entry.name, entry.binding);
    const call = semantics.callForNode(node, bindings);
    if (call) result.push({
      path: filePath, receiver: call.receiver, method: call.method, target: call.binding.target, evidence: call.binding.evidence,
      startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1,
    });
    for (const child of node.namedChildren) visit(child, bindings);
  };
  visit(root, new Map());
  return result;
};

export const directTypeName = (node: Node | null | undefined): string | undefined => {
  if (!node) return undefined;
  if (["identifier", "type_identifier", "predefined_type", "primitive_type"].includes(node.type)) return node.text;
  for (const child of node.namedChildren) {
    const name = directTypeName(child);
    if (name) return name;
  }
  return undefined;
};
