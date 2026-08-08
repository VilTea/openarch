import { Effect } from "effect";
import type { FileAst } from "../../domain/ast";
import { extractTsExportedFunctions } from "./ExportedSymbolExtractor";
import { createTreeSitterRuntime } from "./TreeSitterRuntime";
import { collectStructuralFacts } from "./StructuralFacts";
import { collectImportSources } from "./ImportExtraction";
import { resolveImportRefs } from "./ModuleResolver";
import { tsModuleResolver } from "./TsModuleResolver";
import { collectSemanticSurface } from "./SemanticDeclarations";
import { collectInvocationBindings } from "./InvocationBindingFacts";
import { tsStructuralSemantics, tsImportSyntax } from "./TsAstSemantics";
import { tsDeclarationSyntax } from "./TsDeclarationSyntax";
import { tsBindingSemantics } from "./TsBindingFacts";

const runtime = createTreeSitterRuntime("tree-sitter-typescript.wasm");

const detectLanguage = (filePath: string, language?: FileAst["language"]): FileAst["language"] =>
  language ?? "typescript";

const toTsAst = (filePath: string, root: import("web-tree-sitter").Node, language?: FileAst["language"]): FileAst => {
  const structural = collectStructuralFacts(root, tsStructuralSemantics);
  const imports = resolveImportRefs(filePath, collectImportSources(root, tsImportSyntax), tsModuleResolver);
  return {
    path: filePath,
    language: detectLanguage(filePath, language),
    branchCount: structural.weightedBranchTotal,
    weightedBranchTotal: structural.weightedBranchTotal,
    topLevelWeightedBranch: structural.topLevelWeightedBranch,
    nestingDepth: structural.nestingDepth,
    functionCount: structural.functionCount,
    passthroughCalls: structural.passthroughCalls,
    imports,
    loc: root.endPosition.row - root.startPosition.row - structural.commentLines.size,
    declarationLoc: structural.declarationLines.size,
    maxFuncBranch: structural.maxFuncBranch,
    externalPassthroughCalls: structural.externalPassthroughCalls,
    functions: structural.functions,
    exportedSymbols: extractTsExportedFunctions(root),
    semanticSurface: collectSemanticSurface(root, tsDeclarationSyntax),
  } satisfies FileAst;
};

/** Uses language-specific import resolution around shared Tree-sitter facts. */
export const parseTs = (filePath: string, language?: FileAst["language"]) =>
  Effect.gen(function* () {
    const { root } = yield* runtime.parse(filePath);
    return toTsAst(filePath, root, language);
  });

export const parseTsText = (filePath: string, text: string, language?: FileAst["language"]) =>
  Effect.gen(function* () {
    const { root } = yield* runtime.parseText(filePath, text);
    return toTsAst(filePath, root, language);
  });

export const queryTs = runtime.query;

export const invocationBindingsTs = (filePath: string) => Effect.gen(function* () {
  const { root } = yield* runtime.parse(filePath);
  return collectInvocationBindings(filePath, root, tsBindingSemantics);
});
