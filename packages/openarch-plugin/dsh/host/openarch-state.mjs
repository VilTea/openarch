/**
 * OpenArch DSH 插件 — 治理状态读取器（Host 侧纯逻辑）。
 *
 * 设计目标：
 * - 只读、fail-closed：任何一节读不到就返回 null + error 字符串，绝不伪装成 clean。
 * - 机器事实优先：`openarch context --json` 是 CLI 提供的稳定契约，其余事实直接
 *   读取 `.openarch` 下的本地工件（baseline 分片、history 账本、scan-status）。
 * - 有界输出：所有集合都有上限（history/top-N/分片采样），状态对象永远可 JSON 化。
 *
 * 本模块不依赖任何 npm 包，只使用 Node >= 20 内建 API，便于单测与静态挂载。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readHistorySummary, readJsonIfExists, readTopFiles, round3 } from "./openarch-shards.mjs";
import { KNOWN_CONTRACTS, projectContractCatalog } from "./openarch-contracts.mjs";

const execFileAsync = promisify(execFile);

/** 插件默认参数。生产环境可通过 apply(ctx, config) 覆盖。 */
export const DEFAULTS = Object.freeze({
  /** openarch CLI 可执行名（PATH 上）或绝对路径；可用 OPENARCH_BIN 环境变量覆盖。 */
  openarchBin: process.env.OPENARCH_BIN ?? "openarch",
  /** `openarch context --json` 的超时（毫秒）。 */
  cliTimeoutMs: 30_000,
  /** CLI 输出缓冲上限（字节）。 */
  cliMaxBuffer: 4 * 1024 * 1024,
  /** 状态缓存 TTL（毫秒）；快照过期后 get() 会重新采集。 */
  stateTtlMs: 60_000,
  /** history 账本解析上限（按 mtime 取最新 N 条，再做投影）。 */
  historyParseCap: 40,
  /** 状态中保留的 history 条目数。 */
  historyKeep: 20,
  /** 状态中保留的高局部负担文件数。 */
  topFiles: 12,
  /** 分布直方图桶数。 */
  distributionBins: 10,
  /** 全量读取 baseline 分片的上限；超过则等距采样。 */
  maxShards: 4_000,
});

/** 解析失败返回 null（fail-closed：解析失败就是无事实，不是干净）。 */
const parseJsonText = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * 读取上游机器契约目录（contract --json，contract-catalog-json-v1）。
 * 旧二进制无 contract 命令 / 解析失败 / schema 不识别 → null（fail-closed，
 * 不冒泡、不伪装）。契约版本认识见 openarch-contracts.mjs。
 */
async function loadContractCatalog(options) {
  const run = typeof options.execFileAsync === "function" ? options.execFileAsync : execFileAsync;
  try {
    const { stdout } = await run(options.openarchBin, ["contract", "--json"], {
      cwd: options.cwd,
      timeout: options.cliTimeoutMs,
      maxBuffer: options.cliMaxBuffer,
      windowsHide: true,
      encoding: "utf8",
    });
    return projectContractCatalog(parseJsonText(stdout));
  } catch {
    return null;
  }
}

/**
 * 运行 `openarch context --json` 并返回其稳定 JSON 契约。
 * @returns {{ ok: true, context: object } | { ok: false, error: string }}
 */
export async function loadCliContext(options) {
  const { cwd, openarchBin, cliTimeoutMs, cliMaxBuffer } = options;
  // 未注入接缝时用模块级真实 execFileAsync（工具层总是注入；直接调用者走这里）。
  const run = typeof options.execFileAsync === "function" ? options.execFileAsync : execFileAsync;
  try {
    const { stdout } = await run(openarchBin, ["context", "--json"], {
      cwd,
      timeout: cliTimeoutMs,
      maxBuffer: cliMaxBuffer,
      windowsHide: true,
      encoding: "utf8",
    });
    const context = parseJsonText(stdout);
    if (context === null) {
      return { ok: false, error: "openarch context --json 输出不是合法 JSON" };
    }
    // 上游契约纪律（13a77cea 起）：一律读顶层 schema 判断版本，
    // 不得用"缺 schema 即旧版"反推；未知/缺失一律 fail-closed。
    if (typeof context.schema !== "string" || context.schema !== KNOWN_CONTRACTS.contextJson) {
      return {
        ok: false,
        error: `context-json 契约 schema ${typeof context.schema === "string" ? context.schema : "缺失"} 不被识别（本插件认识 ${KNOWN_CONTRACTS.contextJson}），fail-closed；请升级/重装 openarch。`,
      };
    }
    return { ok: true, context };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

/** 已知的基线指标契约版本；不认识就 fail-closed（标 unsupported，不按旧版结构猜字段）。 */
const KNOWN_METRIC_CONTRACT = "metric-contract-v4";

/** 六项 P95（v5.3 起含 oneMinusConnectedness / externalPassthrough，α 与局部负担口径的直接输入）。 */
const pickP95 = (entry) => (entry && typeof entry.p95 === "object"
  ? {
      branch: round3(entry.p95.branch),
      nesting: round3(entry.p95.nesting),
      loc: round3(entry.p95.loc),
      alpha: round3(entry.p95.alpha),
      oneMinusConnectedness: round3(entry.p95.oneMinusConnectedness),
      externalPassthrough: round3(entry.p95.externalPassthrough),
    }
  : null);

/**
 * 从 baseline 索引提取元数据与 P95 校准。
 * v5.3 结构：meta 之下有 metricContractVersion / snapshotSha256 /
 * policyCalibrations（per-policy 的 current/previous/gate，与
 * calibrationForSubject 口径一致）；全局 meta.calibration 只做概览。
 * 契约版本缺失或不认识 → 只返回 { metricContractVersion, snapshotSha256, unsupported: true }。
 */
async function readBaselineIndex(cwd) {
  const index = await readJsonIfExists(join(cwd, ".openarch", "baseline", "_index.json"));
  if (index === null) return null;
  const meta = index.meta ?? {};
  const metricContractVersion = typeof meta.metricContractVersion === "string" ? meta.metricContractVersion : null;
  const snapshotSha256 = typeof meta.snapshotSha256 === "string" ? meta.snapshotSha256 : null;
  if (metricContractVersion !== KNOWN_METRIC_CONTRACT) {
    return { metricContractVersion, snapshotSha256, unsupported: true };
  }
  const calibration = meta.calibration ?? {};
  const policyCalibrations = meta.policyCalibrations && typeof meta.policyCalibrations === "object" ? meta.policyCalibrations : {};
  const policyIds = Object.keys(policyCalibrations);
  return {
    metricContractVersion,
    snapshotSha256,
    unsupported: false,
    scanAt: typeof meta.scanAt === "string" ? meta.scanAt : null,
    nFiles: typeof meta.nFiles === "number" ? meta.nFiles : null,
    nProductionFiles: typeof meta.nProductionFiles === "number" ? meta.nProductionFiles : null,
    nTestFiles: typeof meta.nTestFiles === "number" ? meta.nTestFiles : null,
    languages: Array.isArray(meta.languages) ? meta.languages : [],
    analysisScope: meta.analysisScope && typeof meta.analysisScope === "object"
      ? { complete: meta.analysisScope.complete === true }
      : null,
    calibration: {
      current: pickP95(calibration.current ?? null),
      previous: pickP95(calibration.previous ?? null),
      gate: pickP95(calibration.gate ?? null),
    },
    policyCalibrations: Object.fromEntries(policyIds.map((id) => {
      const policy = policyCalibrations[id] ?? {};
      return [id, {
        current: pickP95(policy.current ?? null),
        previous: pickP95(policy.previous ?? null),
        gate: pickP95(policy.gate ?? null),
      }];
    })),
  };
}

/** scan-status.json 是 CLI 判断的辅助证据；原样透出少量叶子字段。 */
async function readScanStatus(cwd) {
  const status = await readJsonIfExists(join(cwd, ".openarch", "scan-status.json"));
  if (status === null || typeof status !== "object") return null;
  return {
    status: typeof status.status === "string" ? status.status : null,
    phase: typeof status.phase === "string" ? status.phase : null,
    completed: typeof status.completed === "number" ? status.completed : null,
    total: typeof status.total === "number" ? status.total : null,
    updatedAt: typeof status.updatedAt === "string" ? status.updatedAt : null,
    reason: typeof status.reason === "string" ? status.reason : null,
  };
}

/**
 * 从 .openarch/config.yml 提取展示语言。
 * 刻意不引入 yaml 解析器：只匹配一个已知的顶层标量形状，解析失败
 * 回退到保守默认值（locale 未知 → "zh"）。项目语言以 baseline
 * _index.json 的 meta.languages 为唯一权威来源（见 collectGovernanceState）。
 */
async function readConfigFacts(cwd) {
  let text = null;
  try {
    text = await readFile(join(cwd, ".openarch", "config.yml"), "utf8");
  } catch {
    return { locale: "zh" };
  }
  const localeMatch = text.match(/^\s*locale:\s*["']?([a-z-]+)["']?\s*$/m);
  return {
    locale: localeMatch && (localeMatch[1] === "zh" || localeMatch[1] === "en") ? localeMatch[1] : "zh",
  };
}

/**
 * 采集一份完整、有界的治理状态快照。
 * 每节独立 fail-closed：出错留在对应节的 error 字段，不冒泡、不伪装。
 */
export async function collectGovernanceState(options) {
  const { cwd } = options;
  const initialized = existsSync(join(cwd, ".openarch", "config.yml"));
  const collectedAt = new Date().toISOString();
  if (!initialized) {
    return { root: cwd, initialized: false, collectedAt };
  }

  const cli = await loadCliContext(options);
  const baseline = await readBaselineIndex(cwd).catch(() => null);
  const scanStatus = await readScanStatus(cwd).catch(() => null);
  const config = await readConfigFacts(cwd);
  // 项目语言唯一权威来源：baseline _index.json 的 meta.languages；
  // 不支持/无 baseline 时如实为空（可用 openarch_scan 重建）。
  config.languages = Array.isArray(baseline?.languages) ? baseline.languages : [];
  const history = await readHistorySummary(cwd, options);
  const { top, distribution } = await readTopFiles(cwd, options);
  // 测试治理观察槽：openarch_test 最近一次结果的有界投影（只读观察面，不进入 gate）。
  // reader 按 root 取值：多工作区场景下每个项目各持最近一次评估。
  const testGovernance = typeof options.testGovernanceReader === "function" ? options.testGovernanceReader(cwd) : null;
  // 上游机器契约目录（版本感知；旧二进制/漂移 → null，fail-closed）。
  const contractCatalog = await loadContractCatalog(options);

  return {
    root: cwd,
    initialized: true,
    collectedAt,
    cli,
    baseline,
    scanStatus,
    config,
    history,
    top,
    distribution,
    testGovernance,
    contractCatalog,
  };
}

/**
 * 有界缓存：get() 在 TTL 内复用快照；invalidate() 丢弃快照并触发后台重采。
 * snapshot() 供 prompt section 同步读取（可能为 null，也可能过期——由调用方决定）。
 */
export function createGovernanceCache(options) {
  let state = null;
  let inflight = null;

  const refresh = () => {
    if (inflight !== null) return inflight;
    inflight = collectGovernanceState(options)
      .then((next) => {
        state = next;
        return next;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    get() {
      if (state !== null) {
        const ageMs = Date.now() - Date.parse(state.collectedAt ?? 0);
        if (Number.isFinite(ageMs) && ageMs < options.stateTtlMs) return Promise.resolve(state);
      }
      return refresh();
    },
    snapshot: () => state,
    invalidate() {
      state = null;
    },
    refresh,
  };
}

/** 简报渲染在 openarch-brief.mjs（zh/en 双语文案分支集中一处）；此处保持原导入面。 */
export { renderGovernanceBrief } from "./openarch-brief.mjs";

/** 归一化工作区路径：反斜杠统一、去尾部分隔符、小写（Windows 盘符不敏感）。 */
export const normalizeRoot = (root) => (typeof root === "string"
  ? root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  : "");

/**
 * 多工作区缓存管理器：每个工作区根目录一份独立快照（各自 TTL/采集/失效），
 * 数量 bounded（超出丢最旧）。数据通道与工具失效都按 root 定位，
 * 保证"点到哪个项目的会话，看板/工具反映哪个项目"。
 */
export function createGovernanceCaches(options, maxRoots = 16) {
  const caches = new Map();
  const forRoot = (root) => {
    const key = normalizeRoot(root);
    if (key.length === 0) return null;
    let entry = caches.get(key);
    if (!entry) {
      entry = createGovernanceCache({ ...options, cwd: root });
      caches.set(key, entry);
      if (caches.size > maxRoots) {
        caches.delete(caches.keys().next().value);
      }
    }
    return entry;
  };
  return {
    forRoot,
    invalidate(root) {
      caches.get(normalizeRoot(root))?.invalidate();
    },
    invalidateAll() {
      for (const cache of caches.values()) cache.invalidate();
    },
  };
}
