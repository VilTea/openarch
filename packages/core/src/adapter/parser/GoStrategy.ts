import { Effect } from "effect";
import type { Node } from "web-tree-sitter";
import type { FileAst } from "../../domain/ast";
import { extractGoExportedFunctions } from "./ExportedSymbolExtractor";
import { goModuleResolver } from "./GoModuleResolver";
import { collectImportSources, type ImportSyntax } from "./ImportExtraction";
import { resolveImportRefs } from "./ModuleResolver";
import { collectStructuralFacts, type BranchClass, type LanguageStructuralSemantics } from "./StructuralFacts";
import { createTreeSitterRuntime } from "./TreeSitterRuntime";
import { collectSemanticSurface, type DeclarationSyntax } from "./SemanticDeclarations";
import { collectInvocationBindings, directTypeName, type InvocationBindingSemantics } from "./InvocationBindingFacts";

const runtime = createTreeSitterRuntime("tree-sitter-go.wasm");
const jumpTypes = new Set(["return_statement", "break_statement", "continue_statement", "goto_statement", "fallthrough_statement"]);
const switchTypes = new Set(["expression_switch_statement", "type_switch_statement", "select_statement"]);
const caseTypes = new Set(["expression_case", "type_case", "communication_case", "default_case"]);

const isGuardClause = (ifNode: Node): boolean => {
  const consequence = ifNode.childForFieldName?.("consequence");
  if (!consequence) return false;
  const statementList = consequence.namedChildren[0];
  const firstStatement = statementList?.type === "statement_list" ? statementList.namedChildren[0] : statementList;
  return firstStatement ? jumpTypes.has(firstStatement.type) : false;
};

const classifyBranch = (node: Node): BranchClass | undefined => {
  if (node.type === "if_statement") return isGuardClause(node) ? "guard" : "ordinary";
  if (switchTypes.has(node.type)) return "ordinary";
  if (caseTypes.has(node.type)) return "case";
  return undefined;
};

const goSemantics: LanguageStructuralSemantics = {
  functionTypes: new Set(["function_declaration", "func_literal", "method_declaration"]),
  blockTypes: new Set([
    "block", "function_declaration", "func_literal", "method_declaration", "if_statement", "for_statement",
    "expression_switch_statement", "type_switch_statement", "select_statement",
  ]),
  callNodeTypes: new Set(["call_expression"]),
  declarationNodeTypes: new Set([]),
  declarationBlockTypes: new Set(["type_declaration"]),
  classifyBranch,
  functionName: (node) => node.childForFieldName?.("name")?.text ?? "(anonymous)",
  callTarget: (node) => {
    const target = node.childForFieldName?.("function");
    if (!target) return null;
    if (target.type === "identifier") return { kind: "direct", name: target.text };
    if (target.type === "selector_expression") {
      const name = target.childForFieldName?.("field")?.text;
      return name ? { kind: "member", name } : null;
    }
    return null;
  },
};

const goImportSyntax: ImportSyntax = {
  isImportNode: (node) => node.type === "import_spec",
  sourceFromNode: (node) => {
    const pathNode = node.childForFieldName?.("path");
    return pathNode ? pathNode.text.slice(1, -1) : null;
  },
};

const goDeclarationName = (node: Node): string | undefined => {
  const direct = node.childForFieldName?.("name")?.text
    ?? node.namedChildren.find((child) => ["identifier", "field_identifier", "type_identifier"].includes(child.type))?.text;
  if (node.type === "method_declaration" && direct) {
    const receiver = node.childForFieldName?.("receiver");
    const receiverType = receiver ? goReceiverTypeName(receiver) : undefined;
    if (receiverType) return `${receiverType}.${direct}`;
  }
  if (direct) return direct;
  for (const child of node.namedChildren) {
    const nested = goDeclarationName(child);
    if (nested) return nested;
  }
  return undefined;
};

// Go permits the same exported method name on distinct receiver types. The
// shared semantic collector treats nameOf as the declaration identity, so the
// receiver type must be part of that name rather than becoming a Go-only diff
// branch. Pointer and value receivers both normalize to the declared type.
const goReceiverTypeName = (node: Node): string | undefined => {
  if (node.type === "type_identifier") return node.text;
  for (const child of node.namedChildren) {
    const name = goReceiverTypeName(child);
    if (name) return name;
  }
  return undefined;
};

const goDeclarationSyntax: DeclarationSyntax = {
  isImport: (node) => node.type === "import_declaration",
  isIgnored: (node) => node.type === "package_clause",
  isWrapper: (node) => node.type === "type_declaration",
  kindOf: (node) => {
    if (node.type === "type_spec") {
      if (node.namedChildren.some((child) => child.type === "interface_type")) return "interface";
      if (node.namedChildren.some((child) => child.type === "struct_type")) return "class";
    }
    if (["function_declaration", "method_declaration", "method_spec"].includes(node.type)) return "function";
    if (["field_declaration", "var_declaration", "const_declaration"].includes(node.type)) return "field";
    return undefined;
  },
  nameOf: goDeclarationName,
  isPublic: (node) => {
    const name = goDeclarationName(node);
    return !!name && /^[A-Z]/.test(name);
  },
  bodyOf: (node) => node.childForFieldName?.("body")
    ?? node.childForFieldName?.("type")
    ?? node.namedChildren.find((child) => ["block", "struct_type", "interface_type"].includes(child.type)),
};

const toGoAst = (filePath: string, code: string, root: Node): FileAst => {
  const structural = collectStructuralFacts(root, goSemantics);
  const imports = resolveImportRefs(filePath, collectImportSources(root, goImportSyntax), goModuleResolver);
  const totalLines = code.length === 0 ? 0 : code.split(/\r?\n/).length;
  return {
    path: filePath,
    language: "go",
    branchCount: structural.weightedBranchTotal,
    weightedBranchTotal: structural.weightedBranchTotal,
    topLevelWeightedBranch: structural.topLevelWeightedBranch,
    nestingDepth: structural.nestingDepth,
    functionCount: structural.functionCount,
    passthroughCalls: structural.passthroughCalls,
    imports,
    loc: Math.max(0, totalLines - structural.commentLines.size),
    declarationLoc: structural.declarationLines.size,
    maxFuncBranch: structural.maxFuncBranch,
    externalPassthroughCalls: structural.externalPassthroughCalls,
    functions: structural.functions,
    exportedSymbols: extractGoExportedFunctions(root),
    semanticSurface: collectSemanticSurface(root, goDeclarationSyntax),
  } satisfies FileAst;
};

export const parseGo = (filePath: string) =>
  Effect.gen(function* () {
    const { code, root } = yield* runtime.parse(filePath);
    return toGoAst(filePath, code, root);
  });

export const parseGoText = (filePath: string, text: string) =>
  Effect.gen(function* () {
    const { root } = yield* runtime.parseText(filePath, text);
    return toGoAst(filePath, text, root);
  });

export const queryGo = runtime.query;

const goBindingSemantics: InvocationBindingSemantics = {
  scopeTypes: new Set(["function_declaration", "method_declaration", "func_literal"]),
  bindingsForNode: (node) => {
    if (["function_declaration", "method_declaration", "func_literal"].includes(node.type)) return (node.childForFieldName?.("parameters")?.namedChildren ?? []).flatMap((parameter) => {
      if (parameter.type !== "parameter_declaration") return [];
      const name = parameter.childForFieldName?.("name")?.text;
      const target = directTypeName(parameter.childForFieldName?.("type"));
      return name && target ? [{ name, binding: { target, evidence: "parameter_annotation" as const } }] : [];
    });
    const name = node.type === "short_var_declaration"
      ? node.childForFieldName?.("left")?.namedChildren[0]?.text
      : node.type === "var_spec" ? node.childForFieldName?.("name")?.text : undefined;
    const value = node.type === "short_var_declaration" ? node.childForFieldName?.("right")?.namedChildren[0] : node.childForFieldName?.("value")?.namedChildren[0];
    const composite = value?.type === "unary_expression" ? value.namedChildren[0] : value;
    const target = composite?.type === "composite_literal" ? directTypeName(composite.childForFieldName?.("type")) : undefined;
    return name && target ? [{ name, binding: { target, evidence: "local_assignment" as const } }] : [];
  },
  callForNode: (node, bindings) => {
    const target = node.type === "call_expression" ? node.childForFieldName?.("function") : undefined;
    const receiver = target?.type === "selector_expression" ? target.childForFieldName?.("operand")?.text : undefined;
    const method = target?.type === "selector_expression" ? target.childForFieldName?.("field")?.text : undefined;
    const binding = receiver ? bindings.get(receiver) : undefined;
    return receiver && method && binding ? { receiver, method, binding } : undefined;
  },
};

export const invocationBindingsGo = (filePath: string) => Effect.gen(function* () {
  const { root } = yield* runtime.parse(filePath);
  return collectInvocationBindings(filePath, root, goBindingSemantics);
});
