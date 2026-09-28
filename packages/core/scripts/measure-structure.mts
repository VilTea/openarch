// 结构事实测量工具（只读，长期保留）。
//
// 为什么入库（2026-09-27 认知点/指标复盘决定）：
//   复盘与 CHANGELOG 引用了"文件总量 / 每函数最大值 / 概念数代理(声明行) / 单调用点占比 / exposure 分布"
//   这些数字，但当时的临时探针用完即删 ⇒ **报告里的数字不可由库内命令复现**。
//   本工具把它们变成任何人都能重跑的一条命令。
//
// 它与 gate 的关系：**完全复用 gate 的读取路径**，不自己解析、不自己算指标 ——
//   逐文件事实来自 `currentFileMetrics(storage)`（`review` 用的同一权威投影），
//   P95 来自 baseline index 的 `meta.p95`，权重来自 `loadGateConfig()`。
//   因此它不可能与 gate 漂移，也不构成"第二套指标实现"。
//   它只回答"某个文件/整仓现在是什么样"以及"某个分量在全体文件上的分布"，不参与裁决、不改任何状态。
//
// 用法（仓库根）：
//   npx tsx packages/core/scripts/measure-structure.mts <file...>          # 指定文件（仓库相对路径）
//   npx tsx packages/core/scripts/measure-structure.mts --all             # 全部生产文件
//   npx tsx packages/core/scripts/measure-structure.mts --all --exposure  # 额外打印 exposure 分桶
//   npx tsx packages/core/scripts/measure-structure.mts --all --json      # 机器可读
// 诚实边界：读不到 P95（未 scan 或 index 不可读）时 `localBurden`/`exposure` 一律缺失（UNAVAILABLE），
//   绝不用 0 冒充 —— 与 gate 的表述纪律一致；缺失的字段同样不写 0。
import { Effect } from "effect";
import { relative } from "node:path";
import { JsonFileStorageLive } from "../src/adapter/storage/JsonFileStorage";
import { StorageService, type IndexEntry } from "../src/port/StorageService";
import { currentFileMetrics } from "../src/application/currentMetrics";
import { loadGateConfig } from "../src/application/governance/gateConfig";
import { computeCRLStateBreakdown, type P95Values } from "../src/domain/crlState";
import { maxFuncWeightedBranchOf } from "../src/domain/branchMetrics";
import { participatesInPopulation } from "../src/domain/fileParticipation";
import { projectRoot } from "../src/infra/paths";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const withExposure = args.includes("--exposure");
const all = args.includes("--all");
const files = new Set(args.filter((arg) => !arg.startsWith("--")).map((path) => path.replace(/\\/g, "/")));

if (!all && files.size === 0) {
  console.error("用法: npx tsx packages/core/scripts/measure-structure.mts <file...> | --all [--exposure] [--json]");
  process.exit(2);
}

const root = projectRoot();
const storage = await Effect.runPromise(Effect.gen(function* () {
  return yield* StorageService;
}).pipe(Effect.provide(JsonFileStorageLive)));
const [metrics, index] = await Promise.all([
  Effect.runPromise(currentFileMetrics(storage)),
  Effect.runPromise(storage.readIndex()),
]);
const p95 = index?.meta.p95 as P95Values | undefined;
const weights = (await loadGateConfig()).crlStateWeights;

const selected = metrics
  .filter(([, entry]) => participatesInPopulation(entry.fileKind, "production-governance"))
  .filter(([path]) => all || files.has(String(path).replace(/\\/g, "/")) || files.has(relative(root, String(path)).replace(/\\/g, "/")))
  .sort(([left], [right]) => String(left).localeCompare(String(right)));

interface Row {
  readonly path: string;
  readonly weightedBranchTotal?: number;
  readonly maxFuncBranch?: number;
  readonly maxFuncOwner?: string;
  readonly declarationLoc?: number;
  readonly singleCallSiteRatio: number | null;
  readonly nestingDepth: number;
  readonly loc: number;
  readonly externalPassthroughCalls?: number;
  readonly alphaStruct: number;
  readonly localBurden?: number;
  readonly exposure?: number;
}

const rowOf = (path: string, entry: IndexEntry): Row => {
  const breakdown = p95
    ? computeCRLStateBreakdown({
      maxFuncBranch: maxFuncWeightedBranchOf(entry), nestingDepth: entry.nestingDepth,
      loc: entry.loc, declarationLoc: entry.declarationLoc, alphaStruct: entry.alphaStruct,
      connectedness: entry.connectedness, externalPassthroughCalls: entry.externalPassthroughCalls,
      passthroughCalls: entry.passthroughCalls,
    }, p95, weights)
    : undefined;
  return {
    path: relative(root, path).replace(/\\/g, "/"),
    ...(entry.weightedBranchTotal === undefined ? {} : { weightedBranchTotal: Number(entry.weightedBranchTotal.toFixed(2)) }),
    ...(entry.maxFuncBranch === undefined ? {} : { maxFuncBranch: Number(entry.maxFuncBranch.toFixed(2)) }),
    ...(entry.maxFuncBranchOwner ? { maxFuncOwner: `${entry.maxFuncBranchOwner.name}=${entry.maxFuncBranchOwner.weighted}` } : {}),
    ...(entry.declarationLoc === undefined ? {} : { declarationLoc: entry.declarationLoc }),
    singleCallSiteRatio: entry.singleCallSiteRatio === undefined || entry.singleCallSiteRatio === null ? null : Number(entry.singleCallSiteRatio.toFixed(3)),
    nestingDepth: entry.nestingDepth,
    loc: entry.loc,
    ...(entry.externalPassthroughCalls === undefined ? {} : { externalPassthroughCalls: entry.externalPassthroughCalls }),
    alphaStruct: Number(entry.alphaStruct.toFixed(4)),
    ...(breakdown ? { localBurden: Number(breakdown.localBurden.toFixed(4)), exposure: Number(breakdown.exposure.toFixed(4)) } : {}),
  };
};

const rows = selected.map(([path, entry]) => rowOf(String(path), entry));

if (asJson) {
  console.log(JSON.stringify({ p95Available: p95 !== undefined, count: rows.length, files: rows }, null, 1));
} else {
  console.log(`p95: ${p95 ? "available" : "UNAVAILABLE（未 scan 或 index 不可读 ⇒ localBurden/exposure 缺失，不用 0 冒充）"}`);
  console.log("path\tweighted\tmaxFunc\towner\tdeclLoc\tsingleCall\tnesting\tloc\text\talpha\tlocalBurden\texposure");
  for (const row of rows) {
    console.log([
      row.path, row.weightedBranchTotal ?? "-", row.maxFuncBranch ?? "-", row.maxFuncOwner ?? "-",
      row.declarationLoc ?? "-", row.singleCallSiteRatio === null ? "UNAVAILABLE" : row.singleCallSiteRatio,
      row.nestingDepth, row.loc, row.externalPassthroughCalls ?? "-", row.alphaStruct,
      row.localBurden ?? "UNAVAILABLE", row.exposure ?? "UNAVAILABLE",
    ].join("\t"));
  }
}

if (withExposure) {
  const values = rows.flatMap((row) => (row.exposure === undefined ? [] : [row.exposure]));
  if (values.length === 0) {
    console.log("exposure 分布: UNAVAILABLE（缺少 P95）");
  } else {
    const buckets = new Map<string, number>();
    for (const value of values) {
      const key = (Math.floor(value * 20) / 20).toFixed(2);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    const over = values.filter((value) => value > 0.6).length;
    console.log(`exposure 分布（${values.length} 个生产文件，桶宽 0.05，阈值线 0.60）：`);
    for (const [key, count] of [...buckets.entries()].sort(([left], [right]) => Number(left) - Number(right))) {
      console.log(`  ${key}–${(Number(key) + 0.05).toFixed(2)}\t${count}`);
    }
    console.log(`  > 0.60: ${over}/${values.length}（${((over / values.length) * 100).toFixed(1)}%）`);
  }
}
