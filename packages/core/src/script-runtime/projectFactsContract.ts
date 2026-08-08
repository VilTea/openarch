// 持久化边界契约（version-boundary-audit）：structure/script facts 快照按此版本
// 持久化；不兼容版本显式 reject（不静默迁移）。字面量声明供项目规则审计。
import type { InvocationBindingFact } from "../domain/invocationBindings";
import type { SemanticRelationFact, SemanticRelationReport } from "../semantic-relations/types";
import type { FileKind, FileKindRule, TestCaseSpanFact } from "../domain/testGovernance";
import type { Language } from "../domain/ast";
import type { PathClass } from "../application/pathClass";
import type { IndexEntry } from "../port/StorageService";

export const PROJECT_FACTS_BOUNDARY = {
  persistence: "persisted",
  onMismatch: "reject",
  support: "legacy-supported",
} as const;

export const PROJECT_FACTS_VERSION = "project-facts-v2" as const;

/** 脚本事实能力（校准 2026-08-08 第三轮）：开放字符串——域注册表驱动，未知域可声明
 *  但运行时 unavailable（不再封闭枚举，新增事实无需改此类型）。 */
export type ScriptFactCapability = string;
export type FactAvailability = "available" | "partial" | "unavailable";

export interface ScriptFactCapabilityDescription {
  readonly id: ScriptFactCapability;
  readonly summaryId: `scriptFact.${string}`;
  readonly unavailableActionId: `scriptFact.${string}`;
}

/** Public, runtime-owned catalogue for CLI guidance and project script authors. */
export const SCRIPT_FACT_CAPABILITIES: readonly ScriptFactCapabilityDescription[] = [
  {
    id: "file-classification.v1",
    summaryId: "scriptFact.fileClassification.summary",
    unavailableActionId: "scriptFact.fileClassification.unavailable",
  },
  {
    id: "structure-metrics.v1",
    summaryId: "scriptFact.structureMetrics.summary",
    unavailableActionId: "scriptFact.structureMetrics.unavailable",
  },
  {
    id: "authorities.v1",
    summaryId: "scriptFact.authorities.summary",
    unavailableActionId: "scriptFact.authorities.unavailable",
  },
  {
    id: "test-case-spans.v1",
    summaryId: "scriptFact.testCaseSpans.summary",
    unavailableActionId: "scriptFact.testCaseSpans.unavailable",
  },
  {
    id: "invocation-bindings.v1",
    summaryId: "scriptFact.invocationBindings.summary",
    unavailableActionId: "scriptFact.invocationBindings.unavailable",
  },
  {
    id: "semantic-relations.v1",
    summaryId: "scriptFact.semanticRelations.summary",
    unavailableActionId: "scriptFact.semanticRelations.unavailable",
  },
  {
    id: "change-surface.v1",
    summaryId: "scriptFact.changeSurface.summary",
    unavailableActionId: "scriptFact.changeSurface.unavailable",
  },
];

export const isScriptFactRequirements = (value: unknown): value is readonly ScriptFactCapability[] =>
  value === undefined || (Array.isArray(value) && value.every((capability) => typeof capability === "string"));

/** 校验并列出已知可用域（校准 2026-08-08 第三轮）：未知域不再拒绝——可声明，
 *  运行时按域注册表判 unavailable；此函数只提示可用清单，不阻断。 */
export const scriptFactRequirementsError = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((capability) => typeof capability === "string")) {
    return "requires 必须是 capability id 字符串数组。";
  }
  return undefined;
};

export interface FactResult<Value> {
  readonly availability: FactAvailability;
  readonly value?: Value;
  readonly reason?: string;
}

/** Stable file identity and project-declared classifications, not raw path policy. */
export interface ScriptFileFact {
  readonly path: string;
  readonly repositoryPath: string;
  /** Language selected through the shared parser registry from a supported source extension. */
  readonly language?: Language;
  readonly fileKind: FileKind;
  readonly pathClass: string;
}

/** Resolved ownership boundary from project configuration or one script-local declaration. Never inferred from source layout. */
export interface ScriptAuthorityContract {
  readonly id: string;
  readonly owner: string;
  readonly publicEntry?: string;
  /** Declared exact files or directory prefixes (directory paths end in `/`). */
  readonly protectedPaths?: readonly string[];
  /** Engine-derived input files inside this authority boundary; scripts must not re-match paths. */
  readonly protectedFiles?: readonly string[];
  readonly prohibitedImports?: readonly string[];
}

/** A rule-local declaration is private to one script execution; protectedFiles stay engine-derived. */
export interface ScriptAuthorityDeclaration {
  readonly id: string;
  readonly owner: string;
  readonly publicEntry?: string;
  readonly protectedPaths?: readonly string[];
  readonly prohibitedImports?: readonly string[];
}

/** Raw scan facts only. Composite scores, thresholds and gate verdicts stay outside scripts. */
export interface StructureMetricFact {
  readonly path: string;
  readonly repositoryPath: string;
  readonly branchCount: number;
  readonly weightedBranchTotal?: number;
  readonly topLevelWeightedBranch?: number;
  readonly maxFuncBranch?: number;
  readonly nestingDepth: number;
  readonly loc?: number;
  readonly externalPassthroughCalls?: number;
  readonly inDegree: number;
  readonly outDegree: number;
  readonly alphaStruct: number;
  readonly imports?: readonly string[];
  readonly connectedness?: number;
}

/** Versioned provider reports plus their direct relationship facts. No graph closure is implied. */
export interface SemanticRelationsFact {
  readonly reports: readonly SemanticRelationReport[];
  readonly relations: readonly SemanticRelationFact[];
}

/** 变更的声明（定位用——file/anchor/kind；消费者确认属 check 的 C_push 链，
 * 脚本引擎不接 LSP——它的定位正是发现 LSP 与通用静态分析无法捕捉的隐式
 * 依赖（反射/动态 import 等），预计算的消费者列表对脚本无意义）。 */
export interface ChangeSurfaceSymbolFact {
  readonly file: string;
  readonly anchor: string;
  readonly kind: string;
}

/** 变更行的语义容器（所在的方法/函数/类——tree-sitter 查询归属，
 * 非 LSP：脚本引擎自身用于发现 LSP 看不到的隐式依赖，容器只是定位上下文）。 */
export interface ChangeSurfaceContainer {
  readonly name: string;
  readonly kind: "class" | "method" | "function";
}

/** 文件中具体变更的部分（git diff --unified=0 的 hunk，2026-08-07）：
 * 变更行片段（去 +/- 标记）+ before/after 起始行 + 语义容器——脚本可对变更
 * 的具体代码做更细致的变更时隐式依赖分析（变更行内的动态 import/反射/
 * 配置引用，及其所在的函数/类上下文）。 */
export interface ChangeSurfaceHunk {
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly beforeStartLine: number;
  readonly afterStartLine: number;
  readonly container?: ChangeSurfaceContainer;
}

export interface ChangeSurfaceFileChange {
  readonly file: string;
  readonly language: string;
  readonly hunks: readonly ChangeSurfaceHunk[];
}

/** Change-driven surface facts: which declarations changed and who consumes them. */
export interface ChangeSurfaceFact {
  readonly schemaVersion: 2;
  readonly languages: readonly string[];
  readonly changedSymbols: readonly ChangeSurfaceSymbolFact[];
  /** 文件内具体变更部分（hunk 级）——变更时隐式依赖分析的输入。 */
  readonly changes: readonly ChangeSurfaceFileChange[];
}

export interface ProjectFacts {
  readonly version: typeof PROJECT_FACTS_VERSION;
  readonly fileClassification: FactResult<readonly ScriptFileFact[]>;
  readonly structureMetrics: FactResult<readonly StructureMetricFact[]>;
  readonly authorities: FactResult<readonly ScriptAuthorityContract[]>;
  /** Provider-confirmed test scopes; unavailable outside the test-governance collection flow. */
  readonly testCaseSpans: FactResult<readonly TestCaseSpanFact[]>;
  readonly invocationBindings: FactResult<readonly InvocationBindingFact[]>;
  /** Optional typed relationship evidence, collected only when a rule explicitly requires it. */
  readonly semanticRelations: FactResult<SemanticRelationsFact>;
  /** Change-driven surface evidence (C_push chain); unavailable outside a change-set context. */
  readonly changeSurface: FactResult<ChangeSurfaceFact>;
}

/** Declarative engine-owned file prefilter shared by all staged script domains. */
export interface ScriptFileTargets {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  /** Engine-owned language boundary; scripts must not rely on extension globs as their sole guard. */
  readonly languages?: readonly Language[];
  readonly fileKinds?: readonly FileKind[];
  readonly pathClasses?: readonly string[];
  /** `"any"` selects the union of declared authority boundaries. */
  readonly authority?: "any" | readonly string[];
}

export interface ProjectFactsInput {
  readonly files: readonly string[];
  readonly projectRoot?: string;
  readonly fileKindRules?: readonly FileKindRule[];
  readonly pathClasses?: readonly PathClass[];
  readonly baseline?: {
    readonly entries: ReadonlyMap<string, IndexEntry>;
    readonly scopeMatches: boolean;
    readonly metricContractMatches: boolean;
  };
  readonly authorities?: readonly ScriptAuthorityContract[];
  readonly testCaseSpans?: FactResult<readonly TestCaseSpanFact[]>;
  readonly invocationBindings?: FactResult<readonly InvocationBindingFact[]>;
  readonly semanticRelations?: FactResult<SemanticRelationsFact>;
  readonly changeSurface?: FactResult<ChangeSurfaceFact>;
}

