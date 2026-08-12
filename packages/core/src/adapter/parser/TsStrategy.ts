import { Effect } from "effect";
import type { FileAst } from "../../domain/ast";
import { ParseError } from "../../errors/errors";
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
import { extractVueScriptBlock } from "./VueScriptExtractor";
import { readFileSync } from "node:fs";

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
    loc: Math.max(root.endPosition.row - root.startPosition.row - structural.commentLines.size, 1),
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

// --- Vue SFC 支持：提取 <script> 块后按 javascript 语义分析（行号对齐保留源文件行号）---
const vueText = (filePath: string) =>
  Effect.gen(function* () {
    const source = yield* Effect.try({
      try: () => readFileSync(filePath, "utf8"),
      catch: (cause) => new ParseError({ path: filePath, cause: cause instanceof Error ? cause : new Error(String(cause)) }),
    });
    const block = extractVueScriptBlock(source);
    // 模板-only SFC（无 script 块）是合法组件：按空文本解析，指标全 0；
    // loc 用真实文件行数（≥1，满足 baseline 校验）。
    return { code: block?.code ?? "", language: block?.language ?? "javascript", sourceLines: source.split("\n").length };
  });

export const parseVue = (filePath: string) =>
  Effect.gen(function* () {
    const block = yield* vueText(filePath);
    const ast = yield* parseTsText(filePath, block.code, block.language);
    // 模板-only SFC 的 loc 用真实文件行数（空 script 解析 loc=0 会失真且违反 baseline min(1)）。
    return block.code === "" ? { ...ast, loc: block.sourceLines } : ast;
  });

export const parseVueText = (filePath: string, text: string) =>
  Effect.gen(function* () {
    const block = extractVueScriptBlock(text);
    // 模板-only SFC（无 script 块）是合法组件：按空文本解析，指标全 0；
    // loc 用真实文件行数（≥1，满足 baseline 校验）。
    const code = block?.code ?? "";
    const ast = yield* parseTsText(filePath, code, block?.language ?? "javascript");
    return code === "" ? { ...ast, loc: Math.max(text.split("\n").length, 1) } : ast;
  });

export const queryVue = (filePath: string, pattern: string) =>
  Effect.gen(function* () {
    const block = yield* vueText(filePath);
    return yield* runtime.queryText(filePath, block.code, pattern);
  });

export const invocationBindingsVue = (filePath: string) =>
  Effect.gen(function* () {
    const block = yield* vueText(filePath);
    const { root } = yield* runtime.parseText(filePath, block.code);
    return collectInvocationBindings(filePath, root, tsBindingSemantics);
  });
