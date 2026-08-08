import type { Node } from "web-tree-sitter";
import type { DeclarationSyntax } from "./SemanticDeclarations";

const declarationName = (node: Node): string | undefined => {
  if (node.type === "export_specifier") {
    return node.childForFieldName?.("alias")?.text
      ?? node.childForFieldName?.("name")?.text;
  }
  const direct = node.childForFieldName?.("name")?.text
    ?? node.namedChildren.find((child) => ["identifier", "type_identifier", "property_identifier"].includes(child.type))?.text;
  if (direct) return direct;
  for (const child of node.namedChildren) {
    const nested = declarationName(child);
    if (nested) return nested;
  }
  return undefined;
};

const functionInitializer = (node: Node): Node | undefined => {
  if (node.type !== "lexical_declaration") return undefined;
  const declarator = node.namedChildren.find((child) => child.type === "variable_declarator");
  const value = declarator?.childForFieldName?.("value") ?? declarator?.namedChildren.at(-1);
  return value && ["arrow_function", "function_expression"].includes(value.type) ? value : undefined;
};

const declarationBody = (node: Node): Node | undefined =>
  functionInitializer(node)?.childForFieldName?.("body")
  ?? node.childForFieldName?.("body")
  ?? node.namedChildren.find((child) => ["statement_block", "class_body", "interface_body"].includes(child.type));

/** Declaration classification for TypeScript/JavaScript exported surfaces. */
export const tsDeclarationSyntax: DeclarationSyntax = {
  isImport: (node) => node.type === "import_statement",
  isIgnored: (node) => node.type === "string" && node.parent?.type === "export_statement",
  isWrapper: (node) => node.type === "export_statement" || node.type === "export_clause",
  kindOf: (node) => {
    if (["interface_declaration", "type_alias_declaration"].includes(node.type)) return "interface";
    if (node.type === "class_declaration") return "class";
    if (["function_declaration", "method_definition", "method_signature", "export_specifier"].includes(node.type) || functionInitializer(node)) return "function";
    if (["public_field_definition", "property_signature", "lexical_declaration"].includes(node.type)) return "field";
    return undefined;
  },
  nameOf: declarationName,
  isPublic: (node, inherited) => inherited && !/^(private|protected)\b/.test(node.text.trim()),
  contractCompatibilityOf: (node) => ["property_signature", "method_signature"].includes(node.type)
    && /\?\s*(?::|\()/.test(node.text) ? "additive" : undefined,
  isReExport: (node) => node.type === "export_specifier" && node.parent?.parent?.type === "export_statement"
    && node.parent.parent.namedChildren.some((child) => child.type === "string"),
  bodyOf: declarationBody,
};
