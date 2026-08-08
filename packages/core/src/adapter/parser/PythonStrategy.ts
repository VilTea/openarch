import { Effect } from "effect";
import type { Node } from "web-tree-sitter";
import type { FileAst } from "../../domain/ast";
import { collectImportSources, type ImportSyntax } from "./ImportExtraction";
import { resolveImportRefs } from "./ModuleResolver";
import { pythonModuleResolver } from "./PythonModuleResolver";
import { collectSemanticSurface, type DeclarationSyntax } from "./SemanticDeclarations";
import { collectStructuralFacts, type BranchClass, type LanguageStructuralSemantics } from "./StructuralFacts";
import { createTreeSitterRuntime } from "./TreeSitterRuntime";
import { collectInvocationBindings, directTypeName, type InvocationBindingSemantics } from "./InvocationBindingFacts";

const runtime = createTreeSitterRuntime("tree-sitter-python.wasm");
const jumpTypes = new Set(["return_statement", "raise_statement", "break_statement", "continue_statement"]);

const firstStatement = (block: Node | null | undefined): Node | undefined => block?.namedChildren[0];

const isGuardClause = (node: Node): boolean => jumpTypes.has(firstStatement(node.childForFieldName?.("consequence"))?.type ?? "");

const classifyBranch = (node: Node): BranchClass | undefined => {
  if (node.type === "if_statement") return isGuardClause(node) ? "guard" : "ordinary";
  if (node.type === "match_statement") return "ordinary";
  if (node.type === "case_clause") return "case";
  return undefined;
};

const pythonSemantics: LanguageStructuralSemantics = {
  functionTypes: new Set(["function_definition", "lambda"]),
  blockTypes: new Set([
    "block", "function_definition", "lambda", "class_definition", "if_statement", "for_statement",
    "while_statement", "try_statement", "with_statement", "match_statement",
  ]),
  callNodeTypes: new Set(["call"]),
  declarationNodeTypes: new Set(["class_definition"]),
  declarationBlockTypes: new Set([]),
  classifyBranch,
  functionName: (node) => node.type === "lambda" ? "(lambda)" : node.childForFieldName?.("name")?.text ?? "(anonymous)",
  callTarget: (node) => {
    const target = node.childForFieldName?.("function");
    if (!target) return null;
    if (target.type === "identifier") return { kind: "direct", name: target.text };
    if (target.type === "attribute") {
      const name = target.childForFieldName?.("attribute")?.text;
      return name ? { kind: "member", name } : null;
    }
    return null;
  },
};

const pythonImportSyntax: ImportSyntax = {
  isImportNode: (node) => node.type === "import_statement" || node.type === "import_from_statement",
  sourceFromNode: (node) => {
    if (node.type === "import_from_statement") return node.childForFieldName?.("module_name")?.text ?? null;
    return node.namedChildren.find((child) => child.type === "dotted_name")?.text ?? null;
  },
};

const declarationName = (node: Node): string | undefined =>
  node.childForFieldName?.("name")?.text
    ?? node.childForFieldName?.("left")?.text
    ?? node.namedChildren.find((child) => child.type === "identifier")?.text;

const pythonDeclarationSyntax: DeclarationSyntax = {
  isImport: (node) => ["import_statement", "import_from_statement", "future_import_statement"].includes(node.type),
  isIgnored: (node) => node.type === "comment",
  isWrapper: (node) => node.type === "decorated_definition",
  kindOf: (node) => {
    if (node.type === "class_definition") return "class";
    if (node.type === "function_definition") return "function";
    if (node.type === "assignment") return "field";
    return undefined;
  },
  nameOf: declarationName,
  isPublic: (node) => !/^_/.test(declarationName(node) ?? "_"),
  bodyOf: (node) => node.childForFieldName?.("body") ?? undefined,
};

const toPythonAst = (filePath: string, code: string, root: Node): FileAst => {
  const structural = collectStructuralFacts(root, pythonSemantics);
  const imports = resolveImportRefs(filePath, collectImportSources(root, pythonImportSyntax), pythonModuleResolver);
  const totalLines = code.length === 0 ? 0 : code.split(/\r?\n/).length;
  return {
    path: filePath,
    language: "python",
    branchCount: structural.weightedBranchTotal,
    weightedBranchTotal: structural.weightedBranchTotal,
    topLevelWeightedBranch: structural.topLevelWeightedBranch,
    nestingDepth: structural.nestingDepth,
    functionCount: structural.functionCount,
    passthroughCalls: structural.passthroughCalls,
    imports,
    loc: Math.max(1, totalLines - structural.commentLines.size),
    declarationLoc: structural.declarationLines.size,
    maxFuncBranch: structural.maxFuncBranch,
    externalPassthroughCalls: structural.externalPassthroughCalls,
    functions: structural.functions,
    exportedSymbols: root.namedChildren.flatMap((node) => {
      if (node.type !== "function_definition") return [];
      const name = node.childForFieldName?.("name")?.text;
      return name && !name.startsWith("_") ? [{ name, kind: "function" as const }] : [];
    }),
    semanticSurface: collectSemanticSurface(root, pythonDeclarationSyntax),
  } satisfies FileAst;
};

/** Python grammar mapping around shared structural facts and conservative imports. */
export const parsePython = (filePath: string) =>
  Effect.gen(function* () {
    const { code, root } = yield* runtime.parse(filePath);
    return toPythonAst(filePath, code, root);
  });

export const parsePythonText = (filePath: string, text: string) =>
  Effect.gen(function* () {
    const { root } = yield* runtime.parseText(filePath, text);
    return toPythonAst(filePath, text, root);
  });

export const queryPython = runtime.query;

const pythonBindingSemantics: InvocationBindingSemantics = {
  scopeTypes: new Set(["function_definition"]),
  bindingsForNode: (node, bindings) => {
    if (node.type === "import_from_statement") return node.namedChildren.flatMap((item) => {
      if (item.type === "aliased_import") {
        const source = item.childForFieldName?.("name")?.text;
        const name = item.childForFieldName?.("alias")?.text;
        return source && name ? [{ name, binding: { target: source, evidence: "import_alias" as const } }] : [];
      }
      return item.type === "dotted_name" ? [{ name: item.text, binding: { target: item.text, evidence: "import_alias" as const } }] : [];
    });
    if (node.type === "function_definition") return (node.childForFieldName?.("parameters")?.namedChildren ?? []).flatMap((parameter) => {
      if (parameter.type !== "typed_parameter") return [];
      const name = parameter.namedChildren.find((child) => child.type === "identifier")?.text;
      const annotation = directTypeName(parameter.childForFieldName?.("type"));
      const alias = annotation ? bindings.get(annotation) : undefined;
      return name && annotation ? [{ name, binding: { target: alias?.target ?? annotation, evidence: alias?.evidence ?? "parameter_annotation" } }] : [];
    });
    if (node.type !== "assignment") return [];
    const name = node.childForFieldName?.("left")?.text;
    const value = node.childForFieldName?.("right");
    const source = value?.type === "identifier" ? bindings.get(value.text) : undefined;
    const target = source?.target ?? (value?.type === "call" ? directTypeName(value.childForFieldName?.("function")) : undefined);
    const evidence = name?.startsWith("self.") ? "field_assignment" as const : source?.evidence ?? "local_assignment" as const;
    return name && target ? [{ name, binding: { target, evidence } }] : [];
  },
  callForNode: (node, bindings) => {
    const callable = node.type === "call" ? node.childForFieldName?.("function") : undefined;
    const receiver = callable?.type === "attribute" ? callable.childForFieldName?.("object")?.text : undefined;
    const method = callable?.type === "attribute" ? callable.childForFieldName?.("attribute")?.text : undefined;
    const binding = receiver ? bindings.get(receiver) : undefined;
    return receiver && method && binding ? { receiver, method, binding } : undefined;
  },
};

export const invocationBindingsPython = (filePath: string) =>
  Effect.gen(function* () {
    const { root } = yield* runtime.parse(filePath);
    return collectInvocationBindings(filePath, root, pythonBindingSemantics);
  });
