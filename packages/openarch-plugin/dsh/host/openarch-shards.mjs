/**
 * OpenArch DSH 插件 — 分片/账本读取器（Host 纯逻辑）。
 *
 * 从 openarch-state.mjs 拆出的 `.openarch` 内部工件解析：
 * - baseline 分片（sha256-*.json）：结构事实 Top-N 与 branchCount/loc 分布
 * - history 账本（diff-v3-*.json）：最近 N 条变更冲击摘要
 *
 * 拆分动机：控制单文件局部负担（openarch check 曾对 openarch-state.mjs
 * 报 crl_local WARN）。这些是 CLI --json 未覆盖的内部文件格式，
 * 集中在单一模块使该硬编码边界显式可见（P2-10 的阶段性边界）。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const round3 = (value) => (typeof value === "number" ? Math.round(value * 1000) / 1000 : value);

export const readJsonIfExists = async (file) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw error;
  }
};

/**
 * 投影 history 账本：最近 N 条 diff 记录的摘要（不含 diagnosis 全量）。
 * 文件名为 diff-v3-<hash>，无时间序 → 用 mtime 排序；解析失败逐条丢弃。
 */
export async function readHistorySummary(cwd, options) {
  const dir = join(cwd, ".openarch", "history");
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const candidates = names.filter((name) => name.endsWith(".json") && !name.startsWith("_"));
  const withMtime = [];
  for (const name of candidates) {
    try {
      const info = await stat(join(dir, name));
      withMtime.push({ name, mtimeMs: info.mtimeMs });
    } catch {
      // 单条 stat 失败不阻塞整批（fail-closed 于条目级）。
    }
  }
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const summaries = [];
  for (const { name } of withMtime.slice(0, options.historyParseCap)) {
    let record;
    try {
      record = await readJsonIfExists(join(dir, name));
    } catch {
      // 单条损坏记录不阻塞整批（fail-closed 于条目级）。
      continue;
    }
    if (record === null || typeof record !== "object" || !Array.isArray(record.deltas)) continue;
    const deltas = record.deltas.filter((d) => d && typeof d.deltaI === "number");
    const sumAbsDeltaI = deltas.reduce((acc, d) => acc + Math.abs(d.deltaI), 0);
    const maxDelta = deltas.reduce(
      (acc, d) => (Math.abs(d.deltaI) > Math.abs(acc.deltaI) ? d : acc),
      { file: null, deltaI: 0 },
    );
    const diagnosis = Array.isArray(record.diagnosis) ? record.diagnosis : [];
    const deterioration = diagnosis.reduce(
      (acc, d) => acc + (typeof d?.localBurden?.deterioration === "number" ? d.localBurden.deterioration : 0),
      0,
    );
    const improvement = diagnosis.reduce(
      (acc, d) => acc + (typeof d?.localBurden?.improvement === "number" ? d.localBurden.improvement : 0),
      0,
    );
    summaries.push({
      entryId: typeof record.entryId === "string" ? record.entryId : name,
      timestamp: typeof record.timestamp === "string" ? record.timestamp : null,
      files: deltas.length,
      sumAbsDeltaI: round3(sumAbsDeltaI),
      maxDeltaI: round3(maxDelta.deltaI ?? 0),
      maxDeltaFile: maxDelta.file,
      deterioration: round3(deterioration),
      improvement: round3(improvement),
      // 冲击强度（I_push / severityBudget）：sealed replay 可能省略。
      scale: record.scale && typeof record.scale === "object"
        ? {
            severityBudget: typeof record.scale.severityBudget === "number" ? round3(record.scale.severityBudget) : null,
            intensity: typeof record.scale.intensity === "number" ? round3(record.scale.intensity) : null,
          }
        : null,
    });
  }
  return summaries.slice(0, options.historyKeep);
}

/** 等距分布直方图：min/max 闭区间等宽分桶，返回每个桶的 [from, to, count]。 */
function histogram(values, bins) {
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return { min, max, mean: round3(min), count: values.length, buckets: [{ from: round3(min), to: round3(max), count: values.length }] };
  const width = (max - min) / bins;
  const buckets = Array.from({ length: bins }, (_, i) => ({
    from: round3(min + i * width),
    to: round3(min + (i + 1) * width),
    count: 0,
  }));
  for (const value of values) {
    const index = Math.min(bins - 1, Math.floor((value - min) / width));
    buckets[index].count += 1;
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { min: round3(min), max: round3(max), mean: round3(mean), count: values.length, buckets };
}

/**
 * 扫描 baseline 分片：结构事实 Top-N 与 branchCount/loc 分布。
 * 分片是每文件一个 sha256-*.json（约 0.5–2KB/个），全量读取便宜；
 * 超过 maxShards 时等距采样，避免超大项目拖慢状态采集。
 */
export async function readTopFiles(cwd, options) {
  const dir = join(cwd, ".openarch", "baseline");
  let names;
  try {
    names = (await readdir(dir)).filter((name) => name.startsWith("sha256-") && name.endsWith(".json"));
  } catch {
    return { top: [], distribution: null };
  }
  if (names.length === 0) return { top: [], distribution: null };

  const step = names.length > options.maxShards ? Math.ceil(names.length / options.maxShards) : 1;
  const sampled = names.filter((_, index) => index % step === 0);
  const rows = [];
  for (const name of sampled) {
    let shard;
    try {
      shard = await readJsonIfExists(join(dir, name));
    } catch {
      // 单个损坏分片不阻塞整批（fail-closed 于条目级）。
      continue;
    }
    if (shard === null || typeof shard !== "object" || typeof shard.path !== "string") continue;
    rows.push({
      path: shard.path,
      language: typeof shard.language === "string" ? shard.language : null,
      fileKind: typeof shard.fileKind === "string" ? shard.fileKind : null,
      branchCount: round3(shard.branchCount),
      nestingDepth: typeof shard.nestingDepth === "number" ? shard.nestingDepth : null,
      loc: typeof shard.loc === "number" ? shard.loc : null,
      maxFuncBranch: typeof shard.maxFuncBranch === "number" ? shard.maxFuncBranch : null,
      alphaStruct: round3(shard.alphaStruct),
      inDegree: typeof shard.inDegree === "number" ? shard.inDegree : null,
      outDegree: typeof shard.outDegree === "number" ? shard.outDegree : null,
      connectedness: round3(shard.connectedness),
      // 局部负担的直接输入列（分片只有 localBurdenFingerprint 哈希，数值不可展示；
      // 排名仍用 branchCount，这两列仅供交叉印证，标题注明“局部负担输入”）。
      declarationLoc: typeof shard.declarationLoc === "number" ? shard.declarationLoc : null,
      externalPassthroughCalls: typeof shard.externalPassthroughCalls === "number" ? shard.externalPassthroughCalls : null,
    });
  }
  const byBranch = [...rows]
    // 与 review 的结构候选语义一致：只看生产文件；无生产文件时回退全量。
    .filter((row) => row.fileKind === "production")
    .sort((a, b) => b.branchCount - a.branchCount)
    .slice(0, options.topFiles);
  const top = byBranch.length > 0 ? byBranch : [...rows].sort((a, b) => b.branchCount - a.branchCount).slice(0, options.topFiles);
  const distribution = {
    branchCount: histogram(rows.map((r) => r.branchCount).filter((v) => typeof v === "number"), options.distributionBins),
    loc: histogram(rows.map((r) => r.loc).filter((v) => typeof v === "number"), options.distributionBins),
    sampled: rows.length,
    total: names.length,
  };
  return { top, distribution };
}
