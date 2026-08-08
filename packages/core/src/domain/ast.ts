// packages/core/src/domain/ast.ts
export const LANGUAGES = ["typescript", "javascript", "go", "rust", "python", "java"] as const;
export type Language = typeof LANGUAGES[number];

export interface ImportRef {
  /** 解析后的绝对路径（相对仓库根）；null = 外部依赖（node_modules 等） */
  readonly resolvedPath: string | null;
  /** 原始 import 说明符，如 "./helper" / "react" */
  readonly source: string;
  /** Explicit public forwarding, when a language strategy can prove it. Omitted means an ordinary import. */
  readonly relation?: "reexport";
}

/** Parser-confirmed local exported function. Values/classes/re-exports deliberately remain outside this narrow fact. */
export interface ExportedSymbol {
  readonly name: string;
  readonly kind: "function";
}

/** Cross-language declaration facts used to explain a source revision delta. */
export type SemanticDeclarationKind = "interface" | "class" | "function" | "field";

export interface SemanticDeclaration {
  /** Stable within a file: nested members use their containing type as a prefix. */
  readonly id: string;
  readonly kind: SemanticDeclarationKind;
  readonly isPublic: boolean;
  /** Parser-confirmed compatibility of an additive declaration. */
  readonly contractCompatibility?: "additive";
  /** A named export forwards another module's symbol rather than defining it locally. */
  readonly provenance?: "reexport";
  /** Declaration text before its body, normalized by the diff consumer. */
  readonly signature: string;
  /** Function/type body when the grammar exposes one. */
  readonly body?: string;
}

/**
 * A parser may report top-level syntax it cannot classify. A semantic diff must
 * preserve that uncertainty instead of assigning it a low-impact fallback.
 */
export interface SemanticSurface {
  readonly declarations: readonly SemanticDeclaration[];
  readonly unsupportedTopLevel: readonly string[];
}

/** 函数级指标（in-memory only，不持久化。per-file JSON 只存 cohesion 标量） */
export interface FunctionInfo {
  readonly name: string;
  readonly branchCount: number;
  readonly calls: readonly string[];   // 该函数调用的函数名（去重）
}

/** 单个源文件解析后的 AST 指标快照（值对象，immutable） */
export interface FileAst {
  /** 仓库相对路径，如 "src/commands/review.ts" */
  readonly path: string;
  readonly language: Language;
  /** @deprecated 兼容旧 baseline；语义等同 weightedBranchTotal。 */
  readonly branchCount: number;
  /** 文件全部控制流的加权总量：guard/case=0.3，普通 if/switch=1.0。 */
  readonly weightedBranchTotal?: number;
  /** 函数体外的加权控制流：CLI dispatch/脚本入口的独立观察面。 */
  readonly topLevelWeightedBranch?: number;
  /** 最大嵌套层数 */
  readonly nestingDepth: number;
  readonly functionCount: number;
  /** 调用表达式数（透传调用，用于公式 2 Confidence 计算） */
  readonly passthroughCalls: number;
  /** 出度：直接依赖的文件（已解析为 ImportRef） */
  readonly imports: readonly ImportRef[];
  /** Local exported functions recognised by the language strategy; absent means the strategy cannot provide this fact. */
  readonly exportedSymbols?: readonly ExportedSymbol[];
  /** Optional declaration surface for revision-level semantic change analysis. */
  readonly semanticSurface?: SemanticSurface;
  /** 文件行数（tree-sitter endPosition.row - startPosition.row，Phase 2 CRL_state 用） */
  readonly loc?: number;
  /** 声明行（类型/接口/结构体头 + 函数签名行）：crl loc 因子按实现行口径排除（校准 2026-08-08）。 */
  readonly declarationLoc?: number;
  /** 单函数最大加权分支数（functions 中各函数 branchCount 的 max，替换文件级聚合伪阳性） */
  readonly maxFuncBranch?: number;
  /** 已确认的直接非本地调用数；成员/动态调用保持 unknown，不进入 CRL。 */
  readonly externalPassthroughCalls?: number;
  /** 函数级指标（in-memory only，per-file JSON 不存——只存 cohesion 标量） */
  readonly functions: readonly FunctionInfo[];
}

/** 单文件指标快照（写入 baseline.json 的 files[path]） */
export interface FileMetrics {
  readonly path: string;
  readonly branchCount: number;
  readonly nestingDepth: number;
  readonly inDegree: number;
  readonly outDegree: number;
  readonly cohesion: number;
  readonly alphaStruct: number;
}
