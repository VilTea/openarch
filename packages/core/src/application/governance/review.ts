// packages/core/src/application/governance/review.ts
//
// review use case（design v5.3）。
// CRL_state（存量，主信号）+ CRL_历史（历史累积，由 history 重放计算——不用 per-file 的缓存值，
// 因为 scan clearFileMetrics 会把缓存清空，导致历史 CRL 不连续。P0 fix 2026-07-09）。
import { Effect } from "effect";
import { computeCRLStateBreakdown, type P95Values } from "../../domain/crlState";
import { maxFuncWeightedBranchOf, topLevelWeightedBranchOf, weightedBranchTotalOf } from "../../domain/branchMetrics";
import { replayHistoricalCrl } from "./historyCrl";
import { StorageService } from "../../port/StorageService";
import { participatesInPopulation } from "../../domain/fileParticipation";
import { currentFileMetrics } from "../currentMetrics";

export interface ReviewEntry {
  readonly path: string;
  readonly crlState: number;       // 复合诊断值（兼容展示，不参与 gate）
  readonly localBurden: number;    // 局部负担：存量 gate 主信号
  readonly exposure: number;       // 反向 Reach 暴露度
  readonly moduleShape: number;    // 1-connectedness：仅 review 解释
  readonly crl: number;            // CRL_历史：历史累积（history 重放）
  readonly alphaStruct: number;
  readonly branchCount: number;
  readonly weightedBranchTotal: number;
  readonly maxFuncBranch: number;
  readonly topLevelWeightedBranch: number;
  readonly loc?: number;
}

export interface ReviewReport {
  readonly nFiles: number;
  readonly entries: readonly ReviewEntry[];
  readonly top3: readonly ReviewEntry[];
  readonly hasData: boolean;
  readonly p95?: P95Values;
}

const unavailableReview = (): ReviewReport => ({ nFiles: 0, entries: [], top3: [], hasData: false });

export const review = () =>
  Effect.gen(function* () {
    const storage = yield* StorageService;
    const [index, metrics, history] = yield* Effect.all([
      storage.readIndex(), currentFileMetrics(storage), storage.readAllHistory(),
    ]);
    const p95Vals = index?.meta.p95;
    const crlMap = replayHistoricalCrl(history);
    const entries: ReviewEntry[] = metrics.flatMap(([, m]) => {
      if (!participatesInPopulation(m.fileKind, "production-governance")) return [];
      const breakdown = p95Vals ? computeCRLStateBreakdown({
        maxFuncBranch: maxFuncWeightedBranchOf(m), nestingDepth: m.nestingDepth,
        loc: m.loc, alphaStruct: m.alphaStruct,
        connectedness: m.connectedness,
        externalPassthroughCalls: m.externalPassthroughCalls ?? m.passthroughCalls,
      }, p95Vals) : undefined;
      return [{
        path: m.path, crlState: breakdown?.composite ?? 0,
        localBurden: breakdown?.localBurden ?? 0,
        exposure: breakdown?.exposure ?? 0,
        moduleShape: breakdown?.moduleShape ?? 0,
        crl: crlMap.get(m.path) ?? crlMap.get(m.path.replace(/\\/g, "/")) ?? 0,
        alphaStruct: m.alphaStruct,
        branchCount: m.branchCount,
        weightedBranchTotal: weightedBranchTotalOf(m),
        maxFuncBranch: maxFuncWeightedBranchOf(m),
        topLevelWeightedBranch: topLevelWeightedBranchOf(m),
        loc: m.loc,
      }];
    });
    entries.sort((a, b) => b.localBurden - a.localBurden);
    const top3 = entries.filter((entry) => entry.localBurden > 0 || entry.crl > 0).slice(0, 3);
    return { nFiles: entries.length, entries, top3, hasData: entries.some((entry) => entry.localBurden > 0 || entry.crl > 0), p95: p95Vals } as ReviewReport;
  }).pipe(Effect.catchAll(() => Effect.succeed(unavailableReview())));
