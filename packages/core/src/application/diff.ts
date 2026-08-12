// packages/core/src/application/diff.ts
// diff 编排——lock → parse → 图重建(diffGraph) → 冲击计算(diffImpact) → history/CRL/写回。
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { ParserService } from "../port/ParserService";
import { StorageService } from "../port/StorageService";
import { DEFAULT_ANALYSIS_CONCURRENCY } from "../infra/boundedConcurrency";
import { type FileDelta } from "../domain/crl";
import type { ChangeKind } from "../domain/weights";
import type { ImplicitEdge } from "../domain/graph";
import { rebuildGraph } from "./diffGraph";
import { computeFileImpact, type ImpactOutput } from "./diffImpact";
import { loadGateConfig } from "./governance/gateConfig";
import type { MRDiagnosis } from "../domain/mrDiagnosis";
import type { SemanticEvidence } from "../domain/crl";
import { toRelative, toPosixPath } from "../infra/paths";
import type { SemanticFileProfile } from "./semanticDiff";
import { buildImpactPlan, type ImpactPlanItem } from "./impactPlan";
import { computeChangeSurfaceForProfiles, type ChangeSurfaceCollection } from "./changeSurface";
import type { SymbolUseReport } from "../symbol-use/types";
import { replayHistoricalCrl } from "./governance/historyCrl";
import { participatesInPopulation } from "../domain/fileParticipation";
import { assessSymbolScopeAdmissions } from "./symbolScopeAdmission";
import type { SymbolScopeImpactAdmission } from "../domain/symbolScopeAdmission";
import type { SymbolVersionPairReport } from "../domain/symbolVersionPair";
import { withGovernanceWriteLock } from "./governance/writeLock";
import { gitHeadSha, buildGitBeforeMetrics } from "./gitBaseline";

export interface DiffInput {
  readonly changedFiles: readonly string[];
  readonly baselinePath: string;
  /** Legacy explicit fallback for callers without semantic revision facts. */
  readonly changeKind?: ChangeKind;
  readonly semanticProfiles?: readonly SemanticFileProfile[];
  /** Optional worktree semantic evidence; never persisted or used by the impact formula. */
  readonly symbolUseReports?: readonly SymbolUseReport[];
  /** Optional Git version-pair evidence (admission before/after identity, 2026-08-08). */
  readonly versionPairs?: readonly SymbolVersionPairReport[];
  /** Project has durable symbol calibration samples (admission calibration_samples, 2026-08-08). */
  readonly calibrationAvailable?: boolean;
  /** Bounded revision text owned by the caller's change-set fact, for staged analysis. */
  readonly afterTexts?: ReadonlyMap<string, string>;
  /** Worktree candidates are replaceable overlays until pre-commit seals matching staged evidence. */
  readonly persistence?: "history" | "pending";
  readonly revisionKey?: string;
  readonly agentId: string;
  readonly implicitDeps?: readonly ImplicitEdge[];
}
/** Stable routine output: enough to choose the next change-validation action. */
export interface DiffSummary {
  readonly iPush: number;
  readonly dMR: number;
  readonly deltas: readonly FileRefDelta[];
  readonly historyEntryId: string;
  readonly evidenceState: "sealed" | "pending";
}

/** Optional drill-down evidence; it never changes the summary's policy meaning. */
export interface DiffEvidence {
  readonly mrDetail: ReadonlyArray<MRDiagnosis>;
  readonly crl: ReadonlyMap<string, number>;
  readonly impactPlan?: readonly ImpactPlanItem[];
  /** Change-surface impact (C_push) with symbol-only evidence; unavailable languages are reported, never fabricated. */
  readonly changeSurfaces?: ChangeSurfaceCollection;
  /** Present when the caller explicitly requested worktree LSP/compiler evidence. */
  readonly symbolUseReports?: readonly SymbolUseReport[];
  /** Derived report-only formula-admission assessment; callers cannot supply it. */
  readonly symbolScopeAdmissions?: readonly SymbolScopeImpactAdmission[];
}

export interface DiffReport {
  readonly summary: DiffSummary;
  readonly evidence: DiffEvidence;
}
export interface FileRefDelta { readonly file: string; readonly alphaStruct: number; readonly deltaI: number; }

const historyEntryId = (baselineIdentity: string, revisionKey: string, evidence: readonly SemanticEvidence[]): string => {
  const canonicalEvidence = [...evidence].sort((left, right) =>
    `${left.file}:${left.anchor ?? ""}:${left.changeKind}`.localeCompare(`${right.file}:${right.anchor ?? ""}:${right.changeKind}`)
  );
  const source = JSON.stringify({ version: 3, baselineIdentity, revisionKey, evidence: canonicalEvidence });
  return `diff-v3-${createHash("sha256").update(source).digest("hex").slice(0, 24)}`;
};

export const diff = (input: DiffInput) =>
  Effect.gen(function* () {
    const parser = yield* ParserService;
    const storage = yield* StorageService;
    return yield* withGovernanceWriteLock(input.agentId, () => Effect.gen(function* () {

    // 1. 解析变更文件
    const asts = yield* Effect.all(input.changedFiles.map((p) => {
      const afterText = input.afterTexts?.get(toRelative(p));
      return afterText === undefined ? parser.parse(p) : parser.parseText(p, afterText);
    }), { concurrency: DEFAULT_ANALYSIS_CONCURRENCY });
    const profilesByFile = new Map(input.semanticProfiles?.map((profile) => [toPosixPath(profile.file), profile]) ?? []);
    const changesFor = (path: string) => {
      const profile = profilesByFile.get(toRelative(path));
      if (profile) return profile.changes;
      return input.changeKind ? [{ anchor: "manual:file", kind: input.changeKind }] : [];
    };
    if (asts.some((ast) => changesFor(ast.path).length === 0)) {
      return yield* Effect.dieMessage("semantic diff requires a profile or explicit change kind for every file");
    }
    const oldIndex = yield* storage.readIndex();
    const nFiles = (oldIndex?.meta?.nProductionFiles ?? oldIndex?.meta?.nFiles ?? asts.length) || input.changedFiles.length || 1;
    // 冷启动 git 基线（2026-08-11 体验反馈 P2-2 正面实现）：无 baseline 时从
    // git HEAD blob 重建 before 度量，使首次 clone 后未 scan 也能算冲击量。
    // baselineIdentity 用 git HEAD sha（有 scan 后由 scan 的 snapshotSha256 取代）。
    const cwd = process.cwd();
    const gitBaselineSha = oldIndex?.meta.snapshotSha256 ?? gitHeadSha(cwd);
    if (!gitBaselineSha && !oldIndex?.meta.snapshotSha256) {
      return yield* Effect.dieMessage("baseline lacks snapshotSha256 and git HEAD is unavailable; run openarch scan before diff");
    }    const evidence: SemanticEvidence[] = asts.flatMap((ast) => {
      const afterText = input.afterTexts?.get(toRelative(ast.path));
      return (afterText !== undefined || existsSync(ast.path))
      ? changesFor(ast.path).map((change) => ({
        file: toRelative(ast.path), anchor: change.anchor, changeKind: change.kind,
        sha256: createHash("sha256").update(afterText ?? readFileSync(ast.path)).digest("hex"),
      }))
      : [];
    });
    const snapshotSha256 = oldIndex?.meta.snapshotSha256 ?? gitBaselineSha;
    if (!snapshotSha256) {
      return yield* Effect.dieMessage("baseline lacks snapshotSha256; run openarch scan before diff");
    }
    const baselineIdentity = `${snapshotSha256}:${oldIndex?.meta.analysisScope?.fingerprint ?? "git-cold-start"}`;
    const persistence = input.persistence ?? "history";
    const revisionKey = input.revisionKey ?? "legacy";
    const entryId = historyEntryId(baselineIdentity, revisionKey, evidence);
    const existing = persistence === "history" ? yield* storage.readHistoryEntry(entryId) : null;
    const pending = persistence === "pending" && storage.readPendingDiff ? yield* storage.readPendingDiff() : null;
    const pendingBaseMetrics = pending?.revisionKey === revisionKey
      ? new Map(pending.baseMetrics.map(({ file, entry }) => [file, entry]))
      : new Map<string, import("../port/StorageService").IndexEntry | null>();
    if (existing) {
      const allHistory = yield* storage.readAllHistory();
      const crl = replayHistoricalCrl(allHistory);
      const mrDetail = existing.diagnosis ?? [];
      return {
        summary: {
          iPush: existing.deltas.reduce((sum, delta) => sum + delta.deltaI, 0),
          dMR: mrDetail.reduce((sum, diagnosis) => sum + diagnosis.localBurden.deterioration, 0),
          deltas: existing.deltas.map((delta) => ({ file: delta.file, deltaI: delta.deltaI, alphaStruct: delta.alphaStruct ?? 0 })),
          historyEntryId: entryId,
          evidenceState: "sealed",
        },
        evidence: { mrDetail, crl, impactPlan: [] },
      } as DiffReport;
    }

    // 2. 复用 gate 的项目配置：路径层级属于 I_push，CRL_state 权重属于 D_MR。
    const gateConfig = yield* Effect.promise(loadGateConfig);
    const pathClasses = gateConfig.pathEntries;
    const p95 = oldIndex?.meta.p95;

    // 3. 重建完整依赖图（diffGraph）
    const rb = yield* rebuildGraph(asts, storage, input.implicitDeps, gateConfig.analysisScope.fileKindRules);

    // 4. 逐文件计算冲击（diffImpact）+ 汇总 D_MR
    const coldStart = oldIndex === null;
    const impacts: ImpactOutput[] = [];
    for (const ast of asts) {
      const relPath = toRelative(ast.path);
      const oldEntry = pendingBaseMetrics.has(relPath)
        ? pendingBaseMetrics.get(relPath) ?? null
        : yield* storage.readFileMetrics(ast.path);
      const profile = profilesByFile.get(relPath);
      // 冷启动：无 baseline 且无 semantic profile 时，从 git HEAD 重建 before 度量。
      let semanticBefore = profile?.beforeMetrics;
      let semanticBeforeState = profile?.beforeState ?? (profile?.beforeMetrics ? "git" : undefined);
      if (coldStart && !semanticBefore) {
        const gitBefore = yield* Effect.promise(() => buildGitBeforeMetrics(parser, cwd, ast.path));
        if (gitBefore) { semanticBefore = gitBefore; semanticBeforeState = "git"; }
      }
      impacts.push(computeFileImpact({
        ast, graph: rb.graph, inDegrees: rb.inDegrees, reverseEdges: rb.reverseEdges,
        changedSet: rb.changedSet, nFiles, changeKinds: changesFor(ast.path).map((change) => change.kind), pathClasses, oldEntry,
        semanticBefore,
        semanticBeforeState,
        p95, crlStateWeights: gateConfig.crlStateWeights, fileKindRules: gateConfig.analysisScope.fileKindRules,
      }));
    }
    const iPush = impacts.reduce((s, imp) => s + imp.deltaI, 0);
    const dMR = impacts.reduce((s, imp) => s + imp.contributionMR, 0);
    const deltas: FileRefDelta[] = impacts.map(imp => ({ file: imp.relPath, alphaStruct: imp.alphaStruct, deltaI: imp.deltaI }));
    // D_MR 是生产架构变化诊断；测试文件的结构事实不进入其报告或历史。
    const mrDetail = impacts
      .filter((imp) => participatesInPopulation(imp.writeEntry.fileKind, "production-governance"))
      .map((imp) => imp.mrDetail);

    // 5. 历史 + CRL
    const ts = new Date().toISOString();
    const historyDeltas = deltas.map((delta) => ({ file: delta.file, deltaI: delta.deltaI, alphaStruct: delta.alphaStruct }));
    if (persistence === "pending") {
      const writePending = storage.writePendingDiff;
      if (!writePending) return yield* Effect.dieMessage("storage adapter does not support pending diff evidence");
      yield* writePending({
        entryId, revisionKey, timestamp: ts, deltas: historyDeltas, diagnosis: mrDetail, evidence,
        baselineSnapshotSha256: snapshotSha256,
        overlayMetrics: impacts.map((imp) => imp.writeEntry),
        baseMetrics: impacts.map((imp) => ({
          file: imp.relPath,
          entry: pendingBaseMetrics.has(imp.relPath)
            ? pendingBaseMetrics.get(imp.relPath) ?? null
            : imp.oldEntry,
        })),
      });
    } else {
      yield* storage.writeHistory(entryId, historyDeltas, ts, mrDetail, evidence);
    }
    const allHistory = yield* storage.readAllHistory();
    const crl = replayHistoricalCrl(allHistory);

    // 6. Pending diffs expose structural after-metrics through the candidate
    // projection. A history-only caller seals history without mutating the
    // complete baseline; the next scan publishes structural after-facts.

    const impactPlan = input.semanticProfiles ? buildImpactPlan(input.semanticProfiles, rb.reverseEdges, input.symbolUseReports) : [];
    const changeSurfaces = input.semanticProfiles
      ? computeChangeSurfaceForProfiles({ profiles: input.semanticProfiles, symbolUseReports: input.symbolUseReports, pathClasses, reverseEdges: rb.reverseEdges })
      : undefined;
    const symbolScopeAdmissions = input.semanticProfiles && input.symbolUseReports
      ? assessSymbolScopeAdmissions(input.semanticProfiles, input.symbolUseReports, input.versionPairs, input.calibrationAvailable)
      : undefined;
    return {
      summary: { iPush, dMR, deltas, historyEntryId: entryId, evidenceState: persistence === "pending" ? "pending" : "sealed" },
      evidence: {
        mrDetail, crl, impactPlan,
        ...(changeSurfaces ? { changeSurfaces } : {}),
        ...(input.symbolUseReports ? { symbolUseReports: input.symbolUseReports } : {}),
        ...(symbolScopeAdmissions ? { symbolScopeAdmissions } : {}),
      },
    } as DiffReport;
    }));
  });
