import type { IndexEntry } from "../port/StorageService";
import { isFileKind, type FileKind, type FileKindRule, type TestCaseSpanFact } from "../domain/testGovernance";
import type { PathClass } from "../application/pathClass";
import { classifyPath } from "../application/pathClass";
import { classifyFileKindWithPolicy } from "../domain/testGovernance";
import { METRIC_CONTRACT_VERSION } from "../domain/metricCatalog";
import { toAbsolute, toRelative } from "../infra/paths";
import { isAbsolute, relative, resolve } from "node:path";
import { minimatch } from "minimatch";
import type { InvocationBindingFact } from "../domain/invocationBindings";
import type { SemanticRelationFact, SemanticRelationReport } from "../semantic-relations/types";
import { findLanguageForFile } from "../languageSupport";
import { LANGUAGES, type Language } from "../domain/ast";

// 契约类型/常量/守卫拆至 projectFactsContract（校准 2026-08-08）：re-export 保持
// 30 个消费方 import 面不变；本文件保留构建/授权/文件选择逻辑。
export * from "./projectFactsContract";
import { isScriptFactRequirements, scriptFactRequirementsError, PROJECT_FACTS_VERSION, type FactAvailability, type FactResult, type ProjectFacts, type ProjectFactsInput, type ScriptAuthorityContract, type ScriptAuthorityDeclaration, type ScriptFactCapability, type ScriptFileTargets, type StructureMetricFact } from "./projectFactsContract";
import { scriptDomainResult } from "./factDomains";

export const normalizeRepositoryPath = (path: string, projectRoot?: string): string => {
  const relativePath = isAbsolute(path)
    ? projectRoot ? relative(resolve(projectRoot), resolve(path)) : toRelative(path)
    : path;
  return relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
};

const protectedPath = (path: string): string | undefined => {
  if (!path || isAbsolute(path)) return undefined;
  const normalized = normalizeRepositoryPath(path);
  return normalized && !normalized.startsWith("../") && normalized !== ".." ? normalized : undefined;
};

const validStringList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Validates script-owned declarations without accepting engine-derived protectedFiles. */
export const isScriptAuthorityDeclaration = (value: unknown): value is ScriptAuthorityDeclaration => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const authority = value as Record<string, unknown>;
  return typeof authority.id === "string" && authority.id.length > 0
    && typeof authority.owner === "string" && authority.owner.length > 0
    && (authority.publicEntry === undefined || typeof authority.publicEntry === "string")
    && (authority.protectedPaths === undefined || (validStringList(authority.protectedPaths) && authority.protectedPaths.every((path) => !!protectedPath(path))))
    && (authority.prohibitedImports === undefined || validStringList(authority.prohibitedImports))
    && authority.protectedFiles === undefined;
};

/** A trailing slash denotes a directory subtree; every other protected path is an exact file. */
export const isAuthorityProtectedRepositoryPath = (authority: ScriptAuthorityContract, path: string): boolean => {
  const candidate = normalizeRepositoryPath(path);
  return (authority.protectedPaths ?? []).some((configuredPath) => {
    const boundary = protectedPath(configuredPath);
    if (!boundary) return false;
    return boundary.endsWith("/") ? candidate.startsWith(boundary) : candidate === boundary;
  });
};

export const authorityIdsForPath = (authorities: readonly ScriptAuthorityContract[], path: string): readonly string[] =>
  authorities.filter((authority) => isAuthorityProtectedRepositoryPath(authority, path)).map((authority) => authority.id);

/** Adds a script-private authority to this execution only, without mutating project configuration. */
export const withRuleLocalAuthority = (
  facts: ProjectFacts,
  authority: ScriptAuthorityDeclaration,
): { readonly facts?: ProjectFacts; readonly unavailable?: string; readonly error?: string } => {
  if (facts.authorities.availability !== "available") {
    return { unavailable: `authorities.v1 is ${facts.authorities.availability}${facts.authorities.reason ? `: ${facts.authorities.reason}` : ""}` };
  }
  if (facts.fileClassification.availability !== "available") {
    return { unavailable: `file-classification.v1 is ${facts.fileClassification.availability}${facts.fileClassification.reason ? `: ${facts.fileClassification.reason}` : ""}` };
  }
  const existing = facts.authorities.value ?? [];
  if (existing.some((candidate) => candidate.id === authority.id)) {
    return { error: `rule-local authority id collides with project authority: ${authority.id}` };
  }
  const local: ScriptAuthorityContract = {
    ...authority,
    protectedFiles: (facts.fileClassification.value ?? [])
      .filter((file) => isAuthorityProtectedRepositoryPath(authority, file.repositoryPath))
      .map((file) => file.path),
  };
  return {
    facts: {
      ...facts,
      authorities: { availability: "available", value: [...existing, local] },
    },
  };
};

const repositoryPathOf = (path: string, projectRoot?: string): string => normalizeRepositoryPath(path, projectRoot);

const metricFact = (path: string, entry: IndexEntry): StructureMetricFact => ({
  path,
  repositoryPath: repositoryPathOf(path),
  branchCount: entry.branchCount,
  weightedBranchTotal: entry.weightedBranchTotal,
  topLevelWeightedBranch: entry.topLevelWeightedBranch,
  maxFuncBranch: entry.maxFuncBranch,
  nestingDepth: entry.nestingDepth,
  loc: entry.loc,
  externalPassthroughCalls: entry.externalPassthroughCalls,
  inDegree: entry.inDegree,
  outDegree: entry.outDegree,
  alphaStruct: entry.alphaStruct,
  imports: entry.imports,
  connectedness: entry.connectedness,
});

/**
 * Builds one immutable snapshot per command. Rules receive classifications and raw scan facts,
 * never config patterns, weights, thresholds, composite CRL/I_push values or gate decisions.
 */
export const createProjectFacts = (input: ProjectFactsInput): ProjectFacts => {
  const pathClasses = input.pathClasses ?? [{ pattern: "**", name: "default" }];
  const fileFacts = input.files.map((path) => {
    const repositoryPath = repositoryPathOf(path, input.projectRoot);
    return {
      path,
      repositoryPath,
      language: findLanguageForFile(path)?.id,
      fileKind: classifyFileKindWithPolicy(path, input.fileKindRules, { projectRoot: input.projectRoot }),
      pathClass: classifyPath(repositoryPath, pathClasses),
    };
  });
  const authorities = (input.authorities ?? []).map((authority) => ({
    ...authority,
    protectedFiles: fileFacts
      .filter((file) => isAuthorityProtectedRepositoryPath(authority, file.repositoryPath))
      .map((file) => file.path),
  }));
  const testCaseSpans = input.testCaseSpans ?? {
    availability: "unavailable" as const,
    reason: "当前命令没有 provider-confirmed test-case spans。",
  };
  const invocationBindings = input.invocationBindings ?? {
    availability: "unavailable" as const,
    reason: "当前命令没有 language provider-confirmed invocation bindings。",
  };
  const semanticRelations = input.semanticRelations ?? {
    availability: "unavailable" as const,
    reason: "当前规则未声明 semantic-relations.v1。",
  };
  const changeSurface = input.changeSurface ?? {
    availability: "unavailable" as const,
    reason: "change-surface facts 需要变更集上下文（check --semantic 链路）；当前命令没有。",
  };

  if (!input.baseline) {
    return {
      version: PROJECT_FACTS_VERSION,
      fileClassification: { availability: "available", value: fileFacts },
      structureMetrics: { availability: "unavailable", reason: "没有当前命令提供的已扫描结构事实。" },
      authorities: { availability: "available", value: authorities },
      testCaseSpans,
      invocationBindings,
      semanticRelations,
      changeSurface,
    };
  }
  if (!input.baseline.scopeMatches) {
    return {
      version: PROJECT_FACTS_VERSION,
      fileClassification: { availability: "available", value: fileFacts },
      structureMetrics: { availability: "unavailable", reason: "baseline 的 analysis scope 与当前项目配置不一致。" },
      authorities: { availability: "available", value: authorities },
      testCaseSpans,
      invocationBindings,
      semanticRelations,
      changeSurface,
    };
  }
  if (!input.baseline.metricContractMatches) {
    return {
      version: PROJECT_FACTS_VERSION,
      fileClassification: { availability: "available", value: fileFacts },
      structureMetrics: { availability: "unavailable", reason: `baseline 未使用 ${METRIC_CONTRACT_VERSION}。` },
      authorities: { availability: "available", value: authorities },
      testCaseSpans,
      invocationBindings,
      semanticRelations,
      changeSurface,
    };
  }

  const entries = new Map<string, IndexEntry>();
  for (const [path, entry] of input.baseline.entries) {
    entries.set(toAbsolute(path), entry);
    entries.set(toAbsolute(entry.path), entry);
  }
  const present = input.files.flatMap((path) => {
    const entry = entries.get(toAbsolute(path));
    return entry ? [metricFact(path, entry)] : [];
  });
  const availability: FactAvailability = present.length === input.files.length ? "available" : "partial";
  return {
    version: PROJECT_FACTS_VERSION,
    fileClassification: { availability: "available", value: fileFacts },
    structureMetrics: {      availability,
      value: present,
      ...(availability === "partial" ? { reason: "部分当前脚本输入不在 compatible baseline 中。" } : {}),
    },
    authorities: { availability: "available", value: authorities },
    testCaseSpans,
    invocationBindings,
    semanticRelations,
    changeSurface,
  };
};

export const emptyProjectFacts = (): ProjectFacts => ({
  version: PROJECT_FACTS_VERSION,
  fileClassification: { availability: "unavailable", reason: "调用方未组装项目文件分类事实。" },
  structureMetrics: { availability: "unavailable", reason: "调用方未组装已扫描结构事实。" },
  authorities: { availability: "unavailable", reason: "调用方未组装 authority 声明。" },
  testCaseSpans: { availability: "unavailable", reason: "调用方未组装 provider-confirmed test-case spans。" },
  invocationBindings: { availability: "unavailable", reason: "调用方未组装 language provider-confirmed invocation bindings。" },
  semanticRelations: { availability: "unavailable", reason: "调用方未组装 semantic relation facts。" },
  changeSurface: { availability: "unavailable", reason: "调用方未组装 change-surface facts。" },
});

/** 域注册表查找（校准 2026-08-08 第三轮）：稳定域名（structure-metrics）或带版本
 *  （structure-metrics.v1）均可——注册表按稳定名注册，.v1 后缀归一化后查找。 */
const capabilityResult = (facts: ProjectFacts, capability: ScriptFactCapability): FactResult<unknown> => {
  const domain = capability.replace(/\.v\d+$/, "");
  const result = scriptDomainResult(facts, domain);
  return result ?? { availability: "unavailable", reason: `未注册的脚本事实域: ${domain}` };
};

/** Required facts must be complete; partial snapshots are visible but cannot silently validate a rule. */
export const unavailableRequiredFact = (
  requires: readonly ScriptFactCapability[] | undefined,
  facts: ProjectFacts,
): string | undefined => {
  for (const capability of requires ?? []) {
    const result = capabilityResult(facts, capability);
    if (result.availability !== "available") {
      return `${capability} is ${result.availability}${result.reason ? `: ${result.reason}` : ""}`;
    }
  }
  return undefined;
};

const isStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isFileKindList = (value: unknown): value is readonly FileKind[] =>
  Array.isArray(value) && value.every(isFileKind);

/** Validates only declarative selectors; semantic predicates remain script-owned. */
export const isScriptFileTargets = (value: unknown): value is ScriptFileTargets => {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const targets = value as Record<string, unknown>;
  if (!Object.keys(targets).every((key) => ["include", "exclude", "languages", "fileKinds", "pathClasses", "authority"].includes(key))) return false;
  const validPatternList = (patterns: unknown) => isStringList(patterns) && patterns.every((pattern) => !isAbsolute(pattern) && !normalizeRepositoryPath(pattern).split("/").includes(".."));
  return (targets.include === undefined || validPatternList(targets.include))
    && (targets.exclude === undefined || validPatternList(targets.exclude))
    && (targets.languages === undefined || (Array.isArray(targets.languages) && targets.languages.every((language) => (LANGUAGES as readonly string[]).includes(language))))
    && (targets.fileKinds === undefined || isFileKindList(targets.fileKinds))
    && (targets.pathClasses === undefined || isStringList(targets.pathClasses))
    && (targets.authority === undefined || targets.authority === "any" || isStringList(targets.authority));
};

export const targetRequiredCapabilities = (targets: ScriptFileTargets | undefined): readonly ScriptFactCapability[] => {
  if (!targets) return [];
  const required: ScriptFactCapability[] = [];
  if (targets.fileKinds || targets.pathClasses || targets.languages) required.push("file-classification.v1");
  if (targets.authority) required.push("authorities.v1");
  return required;
};

export interface ScriptTargetSelection {
  readonly files: readonly string[];
  readonly unavailable?: string;
}

/** Applies paths, classifications and declared authority boundaries before a script's text stage runs. */
export const selectScriptTargetFiles = (
  files: readonly string[],
  targets: ScriptFileTargets | undefined,
  facts: ProjectFacts,
): ScriptTargetSelection => {
  if (!targets) return { files };
  const classifications = new Map((facts.fileClassification.value ?? []).map((file) => [file.path, file]));
  const authorities = facts.authorities.value ?? [];
  const selectedAuthorityIds = targets.authority === "any"
    ? new Set(authorities.map((authority) => authority.id))
    : new Set(targets.authority ?? []);
  const unknownAuthority = [...selectedAuthorityIds].find((id) => !authorities.some((authority) => authority.id === id));
  if (unknownAuthority) return { files: [], unavailable: `target authority is not declared: ${unknownAuthority}` };
  const authorityFiles = new Set(authorities
    .filter((authority) => selectedAuthorityIds.has(authority.id))
    .flatMap((authority) => (authority.protectedFiles ?? []).map((path) => normalizeRepositoryPath(path))));
  const matches = (path: string, patterns: readonly string[] | undefined): boolean =>
    !patterns || patterns.some((pattern) => minimatch(path, pattern, { dot: true }));
  return {
    files: files.filter((file) => {
      const classification = classifications.get(file);
      if ((targets.fileKinds || targets.pathClasses || targets.languages) && !classification) return false;
      if (!matches(classification?.repositoryPath ?? normalizeRepositoryPath(file), targets.include)) return false;
      if (targets.exclude && matches(classification?.repositoryPath ?? normalizeRepositoryPath(file), targets.exclude)) return false;
      if (targets.fileKinds && !targets.fileKinds.includes(classification!.fileKind)) return false;
      if (targets.pathClasses && !targets.pathClasses.includes(classification!.pathClass)) return false;
      if (targets.languages && (!classification!.language || !targets.languages.includes(classification!.language))) return false;
      return selectedAuthorityIds.size === 0 || authorityFiles.has(normalizeRepositoryPath(file));
    }),
  };
};
