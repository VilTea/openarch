import type { SemanticChange } from "../domain/semanticChanges";
import { toAbsolute, toRelative } from "../infra/paths";
import type { SemanticFileProfile } from "./semanticDiff";
import type { SymbolUseReport } from "../symbol-use/types";
import type { SymbolUseDemand } from "../port/SymbolUseService";

export interface SymbolConsumerEvidence {
  readonly symbol: string;
  readonly providerId: string;
  readonly evidenceSource: SymbolUseReport["origin"]["evidenceSource"];
  readonly declarationsCoverage: SymbolUseReport["state"]["coverage"]["declarations"];
  readonly repositoryReferencesCoverage: SymbolUseReport["state"]["coverage"]["repositoryReferences"];
  readonly consumers: readonly string[];
  /** File-level static imports and symbol-level references describe different facts. */
  readonly staticImportConsumers: readonly string[];
  readonly sharedConsumers: readonly string[];
  readonly staticOnlyConsumers: readonly string[];
  readonly symbolOnlyConsumers: readonly string[];
  readonly reason?: string;
}

export interface ImpactPlanItem {
  readonly file: string;
  readonly publicContracts: readonly string[];
  readonly implementationUnits: readonly string[];
  readonly dependencyUnits: readonly string[];
  readonly directConsumers: readonly string[];
  /** LSP/compiler references are evidence beside static reverse-import edges, never a formula input yet. */
  readonly symbolConsumers: readonly SymbolConsumerEvidence[];
  readonly actions: readonly ImpactPlanAction[];
}

export type ImpactPlanAction =
  | { readonly kind: "verify_direct_consumers"; readonly consumers: readonly string[] }
  | { readonly kind: "verify_public_contract" }
  | { readonly kind: "verify_dependency_boundary" }
  | { readonly kind: "run_affected_quality" };

const publicKinds = new Set<SemanticChange["kind"]>(["interface_add_remove", "class_add_remove", "public_method_sig", "field_add_remove"]);

/** Shared public-contract boundary for impact guidance and symbol-scope admission. */
export const isPublicContractChange = (change: SemanticChange): boolean => publicKinds.has(change.kind);

const units = (changes: readonly SemanticChange[], predicate: (change: SemanticChange) => boolean): readonly string[] =>
  changes.filter(predicate).map((change) => `${change.anchor} (${change.kind})`);

const actionsFor = (publicContracts: readonly string[], dependencyUnits: readonly string[], directConsumers: readonly string[]): readonly ImpactPlanAction[] => [
  ...(publicContracts.length > 0 ? [directConsumers.length > 0
    ? { kind: "verify_direct_consumers" as const, consumers: directConsumers }
    : { kind: "verify_public_contract" as const }] : []),
  ...(dependencyUnits.length > 0 ? [{ kind: "verify_dependency_boundary" as const }] : []),
  { kind: "run_affected_quality" },
];

const changedSymbolNames = (changes: readonly SemanticChange[]): ReadonlySet<string> => new Set(
  changes
    .filter((change) => !change.anchor.startsWith("import:"))
    .map((change) => change.anchor.split(".").at(-1)!)
    // 伪名字（文件级兜底 manual:file / 注释变更 file）不是真实符号——排除
    .filter((name) => Boolean(name) && name !== "file" && !name.startsWith("manual:")),
);

/**
 * A worktree semantic run starts from declared revision changes rather than
 * enumerating every declaration in the repository. Import-only and
 * comment-only changes have no declaration identity for a symbol provider.
 */
export const symbolUseDemandForProfiles = (
  profiles: readonly SemanticFileProfile[],
  consumerFiles?: readonly string[],
): SymbolUseDemand => {
  const declarations = profiles.flatMap((profile) => {
    const names = [...changedSymbolNames(profile.changes)].filter((name) => name !== "file").sort();
    if (names.length > 0) return [{ file: profile.file.replace(/\\/g, "/"), names }];
    // 文件级兜底（--change-override 的 manual:file 无符号名，校准 2026-08-06）：
    // names 空仍进 demand——LspSymbolUse 对空 names 查该文件全部（公共）声明；
    // 纯注释变更（anchor "file" + comment_whitespace）无符号级意义，排除。
    const hasFileLevelSemanticChange = profile.changes.some(
      (change) => change.anchor === "manual:file" || change.kind !== "comment_whitespace",
    );
    return hasFileLevelSemanticChange ? [{ file: profile.file.replace(/\\/g, "/"), names }] : [];
  });
  return { declarations, ...(consumerFiles && consumerFiles.length > 0 ? { consumerFiles } : {}) };
};

const symbolConsumersFor = (
  profile: SemanticFileProfile,
  reports: readonly SymbolUseReport[] | undefined,
  staticImportConsumers: readonly string[],
): readonly SymbolConsumerEvidence[] => {
  if (!reports) return [];
  const names = changedSymbolNames(profile.changes);
  // names 空 = 文件级兜底（--change-override 的 manual:file，校准 2026-08-06）——
  // 不过滤名字，合并该文件全部（公共）声明的消费者；否则空 set 排除所有 fact，
  // 符号级确认恒为 0。
  return reports.flatMap((report) => report.facts
    .filter((fact) => fact.declaration.file === profile.file && (names.size === 0 || names.has(fact.declaration.name)))
    .map((fact) => {
      const consumers = [...new Set(fact.repositoryReferences.map((reference) => reference.file).filter((file) => file !== profile.file))].sort();
      const staticSet = new Set(staticImportConsumers);
      const symbolSet = new Set(consumers);
      return {
        symbol: fact.declaration.name,
        providerId: report.origin.providerId,
        evidenceSource: report.origin.evidenceSource,
        declarationsCoverage: report.state.coverage.declarations,
        repositoryReferencesCoverage: report.state.coverage.repositoryReferences,
        consumers,
        staticImportConsumers,
        sharedConsumers: consumers.filter((file) => staticSet.has(file)),
        staticOnlyConsumers: staticImportConsumers.filter((file) => !symbolSet.has(file)),
        symbolOnlyConsumers: consumers.filter((file) => !staticSet.has(file)),
        ...(report.state.reason ? { reason: report.state.reason } : {}),
      };
    }),
  );
};

/** Turns existing reverse dependency facts into an agent-facing verification plan. */
export const buildImpactPlan = (
  profiles: readonly SemanticFileProfile[],
  reverseEdges: ReadonlyMap<string, readonly string[]>,
  symbolUseReports?: readonly SymbolUseReport[],
): readonly ImpactPlanItem[] => profiles.flatMap((profile) => {
  const publicContracts = units(profile.changes, isPublicContractChange);
  const dependencyUnits = units(profile.changes, (change) => change.kind === "dependency_add" || change.kind === "dependency_remove");
  const implementationUnits = units(profile.changes, (change) => !publicKinds.has(change.kind) && change.kind !== "dependency_add" && change.kind !== "dependency_remove");
  const staticImportConsumers = [...new Set((reverseEdges.get(toAbsolute(profile.file)) ?? []).map(toRelative))].sort();
  const directConsumers = staticImportConsumers.slice(0, 8);
  const symbolConsumers = symbolConsumersFor(profile, symbolUseReports, staticImportConsumers);
  if (publicContracts.length === 0 && dependencyUnits.length === 0) return [];
  return [{
    file: profile.file,
    publicContracts,
    implementationUnits,
    dependencyUnits,
    directConsumers,
    symbolConsumers,
    actions: actionsFor(publicContracts, dependencyUnits, directConsumers),
  }];
});
