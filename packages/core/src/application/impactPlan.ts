import type { SemanticChange } from "../domain/semanticChanges";
import { toAbsolute, toRelative, toPosixPath } from "../infra/paths";
import type { SemanticFileProfile } from "./semanticDiff";
import type { SymbolUseReport } from "../symbol-use/types";
import type { SymbolUseDemand } from "../port/SymbolUseService";
import { symbolEvidenceDossiersForProfiles, type ChangeSurfaceEvidenceGap } from "./changeSurface";


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
  /**
   * 符号/可见性证据缺口（缺陷 B3 修复）：该文件的符号证据不可用（或静态上界为空而
   * 未查询）时**必须**存在，说明受影响声明与工具链原因。
   *
   * 这是区分两种形态的唯一数据位：`symbolConsumers: []` + `evidenceGap` 存在 =
   * 「证据不可用，消费者数未知」；`symbolConsumers: []` 且无 `evidenceGap` =
   * 「证据可用且确认 0 消费者」。证据可用时此字段必须缺省，不得凭空发明缺口。
   *
   * 事实由 `changeSurface.symbolEvidenceDossiersForProfiles` 唯一权威判定后传入，
   * 本文件不重新判断 provider 是否可用（认知点原则）。
   */
  readonly evidenceGap?: ChangeSurfaceEvidenceGap;
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
    if (names.length > 0) return [{ file: toPosixPath(profile.file), names }];
    // 文件级兜底（--change-override 的 manual:file 无符号名，校准 2026-08-06）：
    // names 空仍进 demand——LspSymbolUse 对空 names 查该文件全部（公共）声明；
    // 纯注释变更（anchor "file" + comment_whitespace）无符号级意义，排除。
    const hasFileLevelSemanticChange = profile.changes.some(
      (change) => change.anchor === "manual:file" || change.kind !== "comment_whitespace",
    );
    return hasFileLevelSemanticChange ? [{ file: toPosixPath(profile.file), names }] : [];
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

/**
 * Turns existing reverse dependency facts into an agent-facing verification plan.
 *
 * 证据缺口（缺陷 B3）：逐文件缺口取自 `changeSurface.symbolEvidenceDossiersForProfiles`
 * 的权威判定（同一份 profiles/reports/reverseEdges 输入，同一次逻辑），本文件不重复
 * 判断「provider 是否可用」，也不重新拼装原因文案（认知点原则）。缺口只**附加**到
 * 计划条目上：`I_push`/`deltaI` 等数值输出与 actions 一字不改（报告-only）。
 */
export const buildImpactPlan = (
  profiles: readonly SemanticFileProfile[],
  reverseEdges: ReadonlyMap<string, readonly string[]>,
  symbolUseReports?: readonly SymbolUseReport[],
): readonly ImpactPlanItem[] => {
  const evidenceGapByFile = new Map<string, ChangeSurfaceEvidenceGap>(
    symbolEvidenceDossiersForProfiles({ profiles, symbolUseReports, reverseEdges })
      .flatMap((dossier) => (dossier.gap ? [[dossier.file, dossier.gap] as const] : [])),
  );
  return profiles.flatMap((profile) => {
    const publicContracts = units(profile.changes, isPublicContractChange);
    const dependencyUnits = units(profile.changes, (change) => change.kind === "dependency_add" || change.kind === "dependency_remove");
    const implementationUnits = units(profile.changes, (change) => !publicKinds.has(change.kind) && change.kind !== "dependency_add" && change.kind !== "dependency_remove");
    const staticImportConsumers = [...new Set((reverseEdges.get(toAbsolute(profile.file)) ?? []).map(toRelative))].sort();
    const directConsumers = staticImportConsumers.slice(0, 8);
    const symbolConsumers = symbolConsumersFor(profile, symbolUseReports, staticImportConsumers);
    if (publicContracts.length === 0 && dependencyUnits.length === 0) return [];
    const evidenceGap = evidenceGapByFile.get(profile.file);
    return [{
      file: profile.file,
      publicContracts,
      implementationUnits,
      dependencyUnits,
      directConsumers,
      symbolConsumers,
      ...(evidenceGap ? { evidenceGap } : {}),
      actions: actionsFor(publicContracts, dependencyUnits, directConsumers),
    }];
  });
};
