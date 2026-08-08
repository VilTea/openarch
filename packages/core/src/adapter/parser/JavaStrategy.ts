import { Effect } from "effect";
import type { Node } from "web-tree-sitter";
import type { FileAst } from "../../domain/ast";
import { collectImportSources, type ImportSyntax } from "./ImportExtraction";
import { javaModuleResolver } from "./JavaModuleResolver";
import { resolveImportRefs } from "./ModuleResolver";
import { collectSemanticSurface, type DeclarationSyntax } from "./SemanticDeclarations";
import { collectStructuralFacts, type BranchClass, type LanguageStructuralSemantics } from "./StructuralFacts";
import { createTreeSitterRuntime } from "./TreeSitterRuntime";
import { collectInvocationBindings, directTypeName, type InvocationBindingSemantics } from "./InvocationBindingFacts";

const runtime = createTreeSitterRuntime("tree-sitter-java.wasm");
const functionTypes = new Set(["method_declaration", "constructor_declaration", "lambda_expression"]);
const jumpTypes = new Set(["return_statement", "throw_statement", "break_statement", "continue_statement"]);

const isGuardClause = (node: Node): boolean => {
  const consequence = node.childForFieldName?.("consequence");
  const first = consequence?.namedChildren[0];
  return !!first && jumpTypes.has(first.type);
};

const classifyBranch = (node: Node): BranchClass | undefined => {
  if (node.type === "if_statement") return isGuardClause(node) ? "guard" : "ordinary";
  if (node.type === "switch_expression") return "ordinary";
  if (node.type === "switch_label") return "case";
  return undefined;
};

const javaSemantics: LanguageStructuralSemantics = {
  functionTypes,
  blockTypes: new Set([
    "block", "method_declaration", "constructor_declaration", "lambda_expression", "class_declaration", "interface_declaration",
    "if_statement", "for_statement", "enhanced_for_statement", "while_statement", "do_statement", "try_statement", "switch_expression",
  ]),
  callNodeTypes: new Set(["method_invocation"]),
  declarationNodeTypes: new Set(["class_declaration"]),
  declarationBlockTypes: new Set(["interface_declaration", "enum_declaration", "record_declaration"]),
  classifyBranch,
  functionName: (node) => node.type === "lambda_expression" ? "(lambda)" : node.childForFieldName?.("name")?.text ?? "(anonymous)",
  callTarget: (node) => {
    const name = node.childForFieldName?.("name")?.text;
    if (!name) return null;
    return node.childForFieldName?.("object") ? { kind: "member", name } : { kind: "direct", name };
  },
};

const javaPackageSegment = /^[a-z_][a-z0-9_]*$/;

/**
 * 全限定 Java 引用提取（校准 2026-08-05：JUnit 大量 `org.junit.Assert.assertTrue(...)`
 * 全限定调用无 import 语句——静态上界因此低估）。
 * 两种形态（tree-sitter-java 节点不同）：
 * 1. 调用表达式 → field_access 链（`org.junit.Assert`，方法名是 method_invocation 的 name 字段不在其中）；
 * 2. 类型引用 → scoped_identifier（`org.junit.rules.ExpectedException e`）。
 * 匹配条件：首段小写（包路径规范）+ 最后一段首字母大写（类名规范）——排除
 * `myVar.method()`（方法名小写）与 `MyType.Inner`（首段大写，本地类型引用）。
 * 变量/常量调用（`obj.CONSTANT()`）可能误命中，但 resolveLocal 解析失败会被丢弃。
 */
const isFullQualifiedJavaPath = (text: string): boolean => {
  const segments = text.split(".");
  if (segments.length < 2) return false;
  const first = segments[0];
  const last = segments[segments.length - 1];
  return first.length > 0 && javaPackageSegment.test(first) && /^[A-Z]/.test(last);
};

const javaImportSyntax: ImportSyntax = {
  isImportNode: (node) =>
    node.type === "import_declaration"
    || (node.type === "field_access" && isFullQualifiedJavaPath(node.text))
    || (node.type === "scoped_identifier" && isFullQualifiedJavaPath(node.text)),
  sourceFromNode: (node) => {
    if (node.type === "import_declaration") {
      return node.namedChildren.find((child) => child.type === "scoped_identifier")?.text ?? null;
    }
    return node.text;
  },
};

const hasPublicModifier = (node: Node): boolean =>
  node.children.find((child) => child.type === "modifiers")?.children.some((child) => child.text === "public") ?? false;

const declarationName = (node: Node): string | undefined =>
  node.childForFieldName?.("name")?.text
    ?? node.namedChildren.find((child) => child.type === "identifier" || child.type === "variable_declarator")?.childForFieldName?.("name")?.text
    ?? node.namedChildren.find((child) => child.type === "identifier")?.text;

const javaDeclarationSyntax: DeclarationSyntax = {
  isImport: (node) => node.type === "import_declaration" || node.type === "package_declaration",
  isIgnored: (node) => node.type === "comment",
  isWrapper: (node) => node.type === "modifiers",
  kindOf: (node) => {
    if (["interface_declaration", "annotation_type_declaration"].includes(node.type)) return "interface";
    if (["class_declaration", "enum_declaration", "record_declaration"].includes(node.type)) return "class";
    if (["method_declaration", "constructor_declaration"].includes(node.type)) return "function";
    if (["field_declaration", "constant_declaration"].includes(node.type)) return "field";
    return undefined;
  },
  nameOf: declarationName,
  isPublic: (node, inherited) => inherited || hasPublicModifier(node),
  bodyOf: (node) => node.childForFieldName?.("body")
    ?? node.namedChildren.find((child) => ["class_body", "interface_body", "enum_body", "block"].includes(child.type)),
};

const exportedFunctions = (root: Node) => root.namedChildren.flatMap((node) => {
  if (!["class_declaration", "interface_declaration"].includes(node.type) || !hasPublicModifier(node)) return [];
  const body = node.childForFieldName?.("body");
  return (body?.namedChildren ?? []).flatMap((member) => {
    if (member.type !== "method_declaration" || !hasPublicModifier(member)) return [];
    const name = member.childForFieldName?.("name")?.text;
    return name ? [{ name, kind: "function" as const }] : [];
  });
});

const toJavaAst = (filePath: string, code: string, root: Node): FileAst => {
  const structural = collectStructuralFacts(root, javaSemantics);
  const totalLines = code.length === 0 ? 0 : code.split(/\r?\n/).length;
  return {
    path: filePath, language: "java", branchCount: structural.weightedBranchTotal,
    weightedBranchTotal: structural.weightedBranchTotal, topLevelWeightedBranch: structural.topLevelWeightedBranch,
    nestingDepth: structural.nestingDepth, functionCount: structural.functionCount, passthroughCalls: structural.passthroughCalls,
    imports: resolveImportRefs(filePath, collectImportSources(root, javaImportSyntax), javaModuleResolver),
    loc: Math.max(0, totalLines - structural.commentLines.size),
    declarationLoc: structural.declarationLines.size, maxFuncBranch: structural.maxFuncBranch,
    externalPassthroughCalls: structural.externalPassthroughCalls, functions: structural.functions,
    exportedSymbols: exportedFunctions(root), semanticSurface: collectSemanticSurface(root, javaDeclarationSyntax),
  } satisfies FileAst;
};

/** Java grammar mapping around shared structural, declaration and module-resolution contracts. */
export const parseJava = (filePath: string) => Effect.gen(function* () {
  const { code, root } = yield* runtime.parse(filePath);
  return toJavaAst(filePath, code, root);
});

export const parseJavaText = (filePath: string, text: string) => Effect.gen(function* () {
  const { root } = yield* runtime.parseText(filePath, text);
  return toJavaAst(filePath, text, root);
});

export const queryJava = runtime.query;

/** Lexical Java bindings only: typed parameters/local constructors; inheritance, fields and DI remain unavailable. */
const javaBindingSemantics: InvocationBindingSemantics = {
  scopeTypes: functionTypes,
  bindingsForNode: (node, bindings) => {
    if (functionTypes.has(node.type)) return (node.childForFieldName?.("parameters")?.namedChildren ?? []).flatMap((parameter) => {
      if (parameter.type !== "formal_parameter" && parameter.type !== "spread_parameter") return [];
      const name = parameter.childForFieldName?.("name")?.text;
      const target = directTypeName(parameter.childForFieldName?.("type"));
      return name && target ? [{ name, binding: { target, evidence: "parameter_annotation" as const } }] : [];
    });
    if (node.type !== "local_variable_declaration") return [];
    const declaredType = directTypeName(node.childForFieldName?.("type"));
    return node.namedChildren.filter((child) => child.type === "variable_declarator").flatMap((declarator) => {
      const name = declarator.childForFieldName?.("name")?.text;
      const value = declarator.childForFieldName?.("value");
      const target = value?.type === "identifier" ? bindings.get(value.text)?.target : directTypeName(value?.childForFieldName?.("type")) ?? declaredType;
      return name && target ? [{ name, binding: { target, evidence: "local_assignment" as const } }] : [];
    });
  },
  callForNode: (node, bindings) => {
    if (node.type !== "method_invocation") return undefined;
    const receiver = node.childForFieldName?.("object")?.text;
    const method = node.childForFieldName?.("name")?.text;
    const binding = receiver ? bindings.get(receiver) : undefined;
    return receiver && method && binding ? { receiver, method, binding } : undefined;
  },
};

export const invocationBindingsJava = (filePath: string) => Effect.gen(function* () {
  const { root } = yield* runtime.parse(filePath);
  return collectInvocationBindings(filePath, root, javaBindingSemantics);
});
