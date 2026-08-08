import { Effect } from "effect";
import type { Node } from "web-tree-sitter";
import type { FileAst } from "../../domain/ast";
import { extractRustExportedFunctions } from "./ExportedSymbolExtractor";
import { collectImportSources, type ImportSyntax } from "./ImportExtraction";
import { resolveImportRefs } from "./ModuleResolver";
import { rustModuleResolver } from "./RustModuleResolver";
import { collectStructuralFacts, type BranchClass, type LanguageStructuralSemantics } from "./StructuralFacts";
import { createTreeSitterRuntime } from "./TreeSitterRuntime";
import { collectSemanticSurface, type DeclarationSyntax } from "./SemanticDeclarations";
import { collectInvocationBindings, directTypeName, type InvocationBindingSemantics } from "./InvocationBindingFacts";

const runtime = createTreeSitterRuntime("tree-sitter-rust.wasm");
const jumpTypes = new Set(["return_expression", "break_expression", "continue_expression"]);

const firstStatement = (block: Node): Node | undefined => block.namedChildren[0]?.type === "expression_statement"
  ? block.namedChildren[0].namedChildren[0]
  : block.namedChildren[0];

const isGuardClause = (node: Node): boolean => {
  const consequence = node.childForFieldName?.("consequence");
  const first = consequence?.type === "block" ? firstStatement(consequence) : undefined;
  return !!first && jumpTypes.has(first.type);
};

const classifyBranch = (node: Node): BranchClass | undefined => {
  if (node.type === "if_expression") return isGuardClause(node) ? "guard" : "ordinary";
  if (node.type === "match_expression") return "ordinary";
  if (node.type === "match_arm") return "case";
  return undefined;
};

const rustSemantics: LanguageStructuralSemantics = {
  functionTypes: new Set(["function_item", "closure_expression"]),
  blockTypes: new Set([
    "block", "function_item", "closure_expression", "if_expression", "match_expression",
    "loop_expression", "while_expression", "for_expression", "try_block",
  ]),
  callNodeTypes: new Set(["call_expression", "macro_invocation"]),
  declarationNodeTypes: new Set(["trait_item"]),
  declarationBlockTypes: new Set(["struct_item", "enum_item", "type_item"]),
  classifyBranch,
  functionName: (node) => {
    if (node.type === "closure_expression") {
      const declarator = node.parent;
      return declarator?.type === "let_declaration"
        ? declarator.childForFieldName?.("pattern")?.text ?? "(closure)"
        : "(closure)";
    }
    return node.childForFieldName?.("name")?.text ?? "(anonymous)";
  },
  callTarget: (node) => {
    if (node.type === "macro_invocation") {
      const name = node.childForFieldName?.("macro")?.text;
      return name ? { kind: "direct", name } : null;
    }
    const target = node.childForFieldName?.("function");
    if (!target) return null;
    if (target.type === "identifier") return { kind: "direct", name: target.text };
    if (target.type === "field_expression") {
      const name = target.childForFieldName?.("field")?.text;
      return name ? { kind: "member", name } : null;
    }
    return null;
  },
};

/** Only a direct `pub use path::Name [as Alias]` preserves one named public contract. */
const isNamedPublicReexport = (node: Node): boolean => {
  if (node.type !== "use_declaration" || node.children[0]?.text !== "pub") return false;
  const argument = node.childForFieldName?.("argument");
  return argument?.type === "scoped_identifier" || argument?.type === "use_as_clause";
};

const rustImportSyntax: ImportSyntax = {
  // use 语句 + crate:: 模块路径表达式（如 crate::format::Buf::new——内联跨文件
  // 依赖，use 提取会漏；校准 2026-08-05：serde format.rs 文件级上界因此为 0）。
  isImportNode: (node) =>
    node.type === "use_declaration"
    || (node.type === "scoped_identifier" && node.text.startsWith("crate::")),
  isReexportNode: isNamedPublicReexport,
  sourceFromNode: (node) =>
    node.type === "use_declaration" ? (node.childForFieldName?.("argument")?.text ?? null) : node.text,
};

const rustDeclarationName = (node: Node): string | undefined => {
  if (node.type === "use_declaration") {
    const argument = node.childForFieldName?.("argument");
    if (argument?.type === "use_as_clause") return argument.childForFieldName?.("alias")?.text;
    if (argument?.type === "scoped_identifier") return argument.childForFieldName?.("name")?.text;
    return undefined;
  }
  const direct = node.childForFieldName?.("name")?.text
    ?? node.namedChildren.find((child) => ["identifier", "type_identifier", "field_identifier"].includes(child.type))?.text;
  if (direct) return direct;
  for (const child of node.namedChildren) {
    const nested = rustDeclarationName(child);
    if (nested) return nested;
  }
  return undefined;
};

const rustDeclarationSyntax: DeclarationSyntax = {
  isImport: (node) => node.type === "use_declaration" && !isNamedPublicReexport(node),
  isIgnored: (node) => node.type === "inner_attribute_item",
  isWrapper: () => false,
  kindOf: (node) => {
    if (["trait_item", "type_item"].includes(node.type)) return "interface";
    if (["struct_item", "enum_item", "union_item"].includes(node.type)) return "class";
    if (["function_item", "function_signature"].includes(node.type)) return "function";
    if (isNamedPublicReexport(node)) return "function";
    if (["field_declaration", "const_item", "static_item"].includes(node.type)) return "field";
    return undefined;
  },
  nameOf: rustDeclarationName,
  isPublic: (node, inherited) => inherited || /^pub\b/.test(node.text.trim()),
  isReExport: isNamedPublicReexport,
  bodyOf: (node) => node.childForFieldName?.("body")
    ?? node.namedChildren.find((child) => ["block", "declaration_list", "field_declaration_list"].includes(child.type)),
};

const toRustAst = (filePath: string, code: string, root: Node): FileAst => {
  const structural = collectStructuralFacts(root, rustSemantics);
  const imports = resolveImportRefs(filePath, collectImportSources(root, rustImportSyntax), rustModuleResolver);
  const totalLines = code.length === 0 ? 0 : code.split(/\r?\n/).length;
  return {
    path: filePath,
    language: "rust",
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
    exportedSymbols: extractRustExportedFunctions(root),
    semanticSurface: collectSemanticSurface(root, rustDeclarationSyntax),
  } satisfies FileAst;
};

/** Rust grammar mapping around shared structural facts and conservative Cargo resolution. */
export const parseRust = (filePath: string) =>
  Effect.gen(function* () {
    const { code, root } = yield* runtime.parse(filePath);
    return toRustAst(filePath, code, root);
  });

export const parseRustText = (filePath: string, text: string) =>
  Effect.gen(function* () {
    const { root } = yield* runtime.parseText(filePath, text);
    return toRustAst(filePath, text, root);
  });

export const queryRust = runtime.query;

const rustBindingSemantics: InvocationBindingSemantics = {
  scopeTypes: new Set(["function_item", "closure_expression"]),
  bindingsForNode: (node, bindings) => {
    if (node.type === "function_item") return (node.childForFieldName?.("parameters")?.namedChildren ?? []).flatMap((parameter) => {
      if (parameter.type !== "parameter") return [];
      const name = parameter.childForFieldName?.("pattern")?.text;
      const target = directTypeName(parameter.childForFieldName?.("type"));
      return name && target ? [{ name, binding: { target, evidence: "parameter_annotation" as const } }] : [];
    });
    if (node.type !== "let_declaration") return [];
    const name = node.childForFieldName?.("pattern")?.text;
    const value = node.childForFieldName?.("value");
    const target = value?.type === "identifier" ? bindings.get(value.text)?.target : value?.type === "call_expression" ? directTypeName(value.childForFieldName?.("function")) : undefined;
    return name && target ? [{ name, binding: { target, evidence: "local_assignment" as const } }] : [];
  },
  callForNode: (node, bindings) => {
    const target = node.type === "call_expression" ? node.childForFieldName?.("function") : node.type === "method_call_expression" ? node : undefined;
    const receiver = target?.childForFieldName?.("receiver")?.text ?? target?.childForFieldName?.("value")?.text;
    const method = target?.childForFieldName?.("method")?.text ?? target?.childForFieldName?.("field")?.text;
    const binding = receiver ? bindings.get(receiver) : undefined;
    return receiver && method && binding ? { receiver, method, binding } : undefined;
  },
};

export const invocationBindingsRust = (filePath: string) => Effect.gen(function* () {
  const { root } = yield* runtime.parse(filePath);
  return collectInvocationBindings(filePath, root, rustBindingSemantics);
});
