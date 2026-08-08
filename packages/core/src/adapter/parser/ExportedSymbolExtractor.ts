import type { Node } from "web-tree-sitter";
import type { ExportedSymbol } from "../../domain/ast";

const symbol = (name: string): ExportedSymbol => ({ name, kind: "function" });

/** TS/JS local export fact: exported function declarations and exported arrow-function variables only. */
export const extractTsExportedFunctions = (root: Node): readonly ExportedSymbol[] => {
  const symbols = new Map<string, ExportedSymbol>();
  const add = (node: Node | null | undefined): void => {
    const name = node?.childForFieldName?.("name")?.text;
    if (name) symbols.set(name, symbol(name));
  };
  const walk = (node: Node): void => {
    if (node.type === "export_statement") {
      const declaration = node.childForFieldName?.("declaration");
      if (declaration?.type === "function_declaration") add(declaration);
      if (declaration?.type === "lexical_declaration") {
        for (const declarator of declaration.namedChildren.filter((child) => child.type === "variable_declarator")) {
          const value = declarator.childForFieldName?.("value");
          if (value?.type === "arrow_function" || value?.type === "function_expression") add(declarator);
        }
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return [...symbols.values()].sort((a, b) => a.name.localeCompare(b.name));
};

/** Go package visibility is encoded by an uppercase identifier; only top-level functions join the narrow S2 fact. */
export const extractGoExportedFunctions = (root: Node): readonly ExportedSymbol[] => root.namedChildren.flatMap((node) => {
  if (node.type !== "function_declaration") return [];
  const name = node.childForFieldName?.("name")?.text;
  return name && /^[A-Z]/.test(name) ? [symbol(name)] : [];
});

/** Rust visibility is syntax, so only public top-level functions join the narrow S2 fact. */
export const extractRustExportedFunctions = (root: Node): readonly ExportedSymbol[] => root.namedChildren.flatMap((node) => {
  if (node.type !== "function_item" || !node.namedChildren.some((child) => child.type === "visibility_modifier")) return [];
  const name = node.childForFieldName?.("name")?.text;
  return name ? [symbol(name)] : [];
});
