import { Effect } from "effect";
import { createAnalysisScope } from "../domain/analysisScope";
import { METRIC_CONTRACT_VERSION } from "../domain/metricCatalog";
import { projectRoot } from "../infra/paths";
import { StorageService, type BaselineIndex, type IndexEntry } from "../port/StorageService";
import { ParserService } from "../port/ParserService";
import { SemanticRelationService } from "../port/SemanticRelationService";
import { readProjectFileKindRules, readProjectLanguages } from "../projectFiles";
import { createProjectFacts, type FactResult, type ProjectFacts, type ScriptAuthorityContract, type ScriptFactCapability, type SemanticRelationsFact, type ChangeSurfaceFact } from "../script-runtime/projectFacts";
import type { InvocationBindingFact } from "../domain/invocationBindings";
import type { TestCaseSpanFact } from "../domain/testGovernance";
import { loadGateConfig } from "./governance/gateConfig";
import { currentFileMetrics } from "./currentMetrics";
import { DEFAULT_ANALYSIS_CONCURRENCY } from "../infra/boundedConcurrency";

export interface ScriptFactBaseline {
  readonly entries: ReadonlyMap<string, IndexEntry>;
  readonly index: BaselineIndex | null;
}

export interface ScriptFactsOptions {
  readonly files: readonly string[];
  readonly authorities?: readonly ScriptAuthorityContract[];
  readonly testCaseSpans?: FactResult<readonly TestCaseSpanFact[]>;
  /** Expensive typed facts are collected only for capabilities requested by loaded project scripts. */
  readonly requestedCapabilities?: readonly ScriptFactCapability[];
  /** Lets an application that already read baseline state avoid a second repository traversal. */
  readonly baseline?: ScriptFactBaseline;
  /** Change-set surface facts (C_push chain); callers with a change-set context may inject them. */
  readonly changeSurface?: FactResult<ChangeSurfaceFact>;
}

const buildFacts = async (
  options: ScriptFactsOptions,
  bindings: FactResult<readonly InvocationBindingFact[]>,
  semanticRelations: FactResult<SemanticRelationsFact>,
  baseline?: ScriptFactBaseline,
): Promise<ProjectFacts> => {
  const root = projectRoot();
  const languages = readProjectLanguages(root);
  const fileKindRules = readProjectFileKindRules(root);
  const gateConfig = await loadGateConfig();
  const scope = createAnalysisScope(languages, fileKindRules);
  return createProjectFacts({
    files: options.files,
    projectRoot: root,
    fileKindRules,
    pathClasses: gateConfig.pathEntries,
    authorities: options.authorities,
    testCaseSpans: options.testCaseSpans,
    invocationBindings: bindings,
    semanticRelations,
    changeSurface: options.changeSurface,
    ...(baseline ? {
      baseline: {
        entries: baseline.entries,
        scopeMatches: baseline.index?.meta.analysisScope?.fingerprint === scope.fingerprint
          && baseline.index.meta.analysisScope.complete === true,
        metricContractMatches: baseline.index?.meta.metricContractVersion === METRIC_CONTRACT_VERSION,
      },
    } : {}),
  });
};

const semanticRelationsFor = (requested: readonly ScriptFactCapability[] | undefined) =>
  Effect.gen(function* () {
    if (!requested?.includes("semantic-relations.v1")) {
      return { availability: "unavailable" as const, reason: "当前命令的脚本未声明 semantic-relations.v1。" };
    }
    const service = yield* SemanticRelationService;
    const root = projectRoot();
    const reports = yield* service.collect({ cwd: root, languages: readProjectLanguages(root) });
    const incomplete = reports.filter((report) => report.state.coverage.symbols !== "complete" || report.state.coverage.relations !== "complete");
    return {
      availability: incomplete.length === 0 ? "available" as const : "partial" as const,
      value: { reports, relations: reports.flatMap((report) => report.facts) },
      ...(incomplete.length === 0 ? {} : { reason: incomplete.map((report) => `${report.origin.language}: ${report.state.reason ?? "semantic relation coverage is incomplete"}`).join("; ") }),
    } satisfies FactResult<SemanticRelationsFact>;
  });

const invocationBindingsFor = (requested: readonly ScriptFactCapability[] | undefined, files: readonly string[]) =>
  Effect.gen(function* () {
    if (!requested?.includes("invocation-bindings.v1")) {
      return { availability: "unavailable" as const, reason: "当前命令的脚本未声明 invocation-bindings.v1。" };
    }
    const parser = yield* ParserService;
    if (!parser.invocationBindings) {
      return { availability: "unavailable" as const, reason: "当前 ParserService 未提供 invocation bindings。" };
    }
    return yield* Effect.forEach(
      files,
      (file) => parser.invocationBindings!(file),
      { concurrency: DEFAULT_ANALYSIS_CONCURRENCY },
    ).pipe(
      Effect.match({
        // fail-fast：任一失败走 onFailure（invocationBindings 本就是 Effect——
        // 原来的 async 包装 + runPromise 是对 Effect 的误用，校准 2026-08-07）
        onSuccess: (values) => ({ availability: "available" as const, value: values.flat() }),
        onFailure: (error) => ({ availability: "unavailable" as const, reason: error.message }),
      }),
    );
  });

/** Application-owned composition point: project configuration and storage are read once, then scripts get a snapshot. */
export const loadScriptFacts = (options: ScriptFactsOptions) =>
  Effect.gen(function* () {
    const bindings = yield* invocationBindingsFor(options.requestedCapabilities, options.files);
    const semanticRelations = yield* semanticRelationsFor(options.requestedCapabilities);
    if (options.baseline) return yield* Effect.promise(() => buildFacts(options, bindings, semanticRelations, options.baseline));
    const storage = yield* StorageService;
    const [entries, index] = yield* Effect.all([currentFileMetrics(storage), storage.readIndex()]).pipe(
      Effect.catchAll(() => Effect.succeed([[], null] as const)),
    );
    return yield* Effect.promise(() => buildFacts(options, bindings, semanticRelations, { entries: new Map(entries), index }));
  });
