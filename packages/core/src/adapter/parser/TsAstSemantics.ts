import type { Node } from "web-tree-sitter";
import type { BranchClass, LanguageStructuralSemantics } from "./StructuralFacts";
import type { ImportSyntax } from "./ImportExtraction";

const jumpTypes = new Set(["return_statement", "throw_statement", "continue_statement", "break_statement"]);

const isGuardClause = (ifNode: Node): boolean => {
  const consequence = ifNode.childForFieldName?.("consequence");
  if (!consequence) return false;
  const firstStatement = consequence.type === "statement_block" ? consequence.children[0] : consequence;
  return firstStatement ? jumpTypes.has(firstStatement.type) : false;
};

const classifyBranch = (node: Node): BranchClass | undefined => {
  if (node.type === "if_statement") return isGuardClause(node) ? "guard" : "ordinary";
  if (node.type === "switch_statement") return "ordinary";
  if (node.type === "switch_case" || node.type === "switch_default") return "case";
  return undefined;
};

/** Structural walk semantics for TypeScript/JavaScript ASTs. */
export const tsStructuralSemantics: LanguageStructuralSemantics = {
  functionTypes: new Set(["function_declaration", "arrow_function", "method_definition"]),
  blockTypes: new Set([
    "statement_block", "function_declaration", "arrow_function", "method_definition",
    "if_statement", "for_statement", "for_in_statement", "while_statement",
    "switch_statement", "class_declaration", "try_statement", "catch_clause",
  ]),
  callNodeTypes: new Set(["call_expression"]),
  declarationNodeTypes: new Set(["class_declaration"]),
  declarationBlockTypes: new Set(["interface_declaration", "type_alias_declaration", "enum_declaration"]),
  classifyBranch,
  functionName: (node) => {
    if (node.type === "arrow_function") {
      const parent = node.parent;
      if (parent?.type === "variable_declarator") {
        return parent.children.find((child) => child.type === "identifier")?.text ?? "(arrow)";
      }
      return "(arrow)";
    }
    return node.childForFieldName?.("name")?.text ?? "(anonymous)";
  },
  callTarget: (node) => {
    const target = node.childForFieldName?.("function");
    if (!target) return null;
    if (target.type === "identifier") return { kind: "direct", name: target.text };
    if (target.type === "member_expression") {
      const name = target.childForFieldName?.("property")?.text;
      return name ? { kind: "member", name } : null;
    }
    return null;
  },
};

/** Import/reexport detection for TypeScript/JavaScript syntax. */
export const tsImportSyntax: ImportSyntax = {
  isImportNode: (node) => node.type === "import_statement" || node.type === "export_statement",
  isReexportNode: (node) => node.type === "export_statement" && node.namedChildren.some((child) => child.type === "string"),
  sourceFromNode: (node) => {
    const sourceNode = node.children.find((child) => child.type === "string");
    return sourceNode ? sourceNode.text.slice(1, -1) : null;
  },
};
