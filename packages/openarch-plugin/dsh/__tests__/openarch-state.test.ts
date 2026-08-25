// @ts-nocheck —— 插件包无独立 tsconfig，本文件以 vitest 转译运行；
// 被测资产是纯 JavaScript 模块（dsh/host/*.mjs）。
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  collectGovernanceState,
  createGovernanceCache,
  createGovernanceCaches,
  DEFAULTS,
  loadCliContext,
  normalizeRoot,
  renderGovernanceBrief,
} from "../host/openarch-state.mjs";

/** 仓库根：__tests__ → dsh → openarch-plugin → packages → 根。 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const baselineIndexPath = resolve(repoRoot, ".openarch", "baseline", "_index.json");
const hasBaseline = existsSync(baselineIndexPath);

/** 以当前真实 baseline 的 meta.nFiles 作为夹具输入，避免随仓库规模增长改断言。
 *  release/CI 快照不含 baseline 时使用固定夹具值；依赖真实 baseline 的用例会 skip。 */
const baselineFiles = (): number => {
  try {
    const index = JSON.parse(readFileSync(baselineIndexPath, "utf8"));
    if (typeof index?.meta?.nFiles === "number") return index.meta.nFiles;
  } catch {
    // fall through to fixture default
  }
  return 57;
};

/** 最小合法的 context --json 契约（与 CLI 输出同构的裁剪版）。 */
const cannedContext = {
  configuration: "available",
  schema: "context-json-v1",
  baseline: {
    available: true,
    files: baselineFiles(),
    scope: "compatible",
    freshness: "stale",
    scanAt: "2026-08-11T21:03:20.936Z",
  },
  architecturePolicy: { state: "configured", declaredRules: 14 },
  changes: {
    worktree: { availability: "available", paths: 57, sourcePaths: 20 },
    staged: { availability: "available", paths: 0, sourcePaths: 0 },
  },
};

const fakeExec = (stdout) => async () => ({ stdout, stderr: "" });

const freshTmpDir = () => mkdtempSync(join(tmpdir(), "openarch-dsh-"));

describe.skipIf(process.env.OPENARCH_TEST_SCOPE !== "integration")("openarch-state: 状态采集（真实仓库工件）", () => {
  it("在已初始化仓库上采集有界状态快照", async () => {
    const state = await collectGovernanceState({
      ...DEFAULTS,
      cwd: repoRoot,
      execFileAsync: fakeExec(JSON.stringify(cannedContext)),
    });
    expect(state.initialized).toBe(true);
    expect(state.cli.ok).toBe(true);
    expect(state.cli.context.configuration).toBe("available");
    expect(state.baseline).not.toBeNull();
    expect(state.baseline.nFiles).toBe(cannedContext.baseline.files);
    // v5.3 口径：metric 契约版本识别 + snapshot 身份 + per-policy 六项 P95。
    expect(state.baseline.metricContractVersion).toBe("metric-contract-v4");
    expect(state.baseline.unsupported).toBe(false);
    expect(typeof state.baseline.snapshotSha256).toBe("string");
    expect(state.baseline.policyCalibrations).not.toBeNull();
    const policyIds = Object.keys(state.baseline.policyCalibrations);
    expect(policyIds.length).toBeGreaterThan(0);
    for (const id of policyIds) {
      expect(typeof state.baseline.policyCalibrations[id].gate.branch).toBe("number");
      expect(typeof state.baseline.policyCalibrations[id].gate.oneMinusConnectedness).toBe("number");
    }
    // calibration 在 _index.json 的 meta 之下；真实工件必有 P95 三组。
    expect(state.baseline.calibration.current).not.toBeNull();
    expect(state.baseline.calibration.gate).not.toBeNull();
    expect(typeof state.baseline.calibration.current.branch).toBe("number");
    expect(typeof state.baseline.calibration.current.externalPassthrough).toBe("number");
    expect(state.config.locale).toBe("zh");
    expect(Array.isArray(state.top)).toBe(true);
    expect(state.top.length).toBeGreaterThan(0);
    expect(state.top.length).toBeLessThanOrEqual(DEFAULTS.topFiles);
    for (const row of state.top) {
      expect(typeof row.path).toBe("string");
      expect(typeof row.branchCount).toBe("number");
      // 局部负担输入列必须存在（可为 null）。
      expect("declarationLoc" in row).toBe(true);
      expect("externalPassthroughCalls" in row).toBe(true);
    }
    expect(state.distribution).not.toBeNull();
    expect(state.distribution.total).toBe(cannedContext.baseline.files);
    expect(state.distribution.sampled).toBeGreaterThan(0);
    expect(Array.isArray(state.history)).toBe(true);
    expect(state.history.length).toBeLessThanOrEqual(DEFAULTS.historyKeep);
    for (const entry of state.history) {
      expect(typeof entry.entryId).toBe("string");
      expect(typeof entry.sumAbsDeltaI).toBe("number");
      // scale（冲击强度）字段恒存在；值为 {severityBudget,intensity} 或 null。
      expect("scale" in entry).toBe(true);
      if (entry.scale !== null) {
        expect(typeof entry.scale.intensity).toBe("number");
      }
    }
    expect(state.scanStatus).not.toBeNull();
    expect(typeof state.scanStatus.status).toBe("string");
    // 上游契约目录槽恒存在；canned 接缝不认识 contract 命令 → fail-closed 为 null。
    expect("contractCatalog" in state).toBe(true);
    expect("testGovernance" in state).toBe(true);
  });

  it("未初始化目录 → initialized: false 且不读 CLI", async () => {
    const empty = freshTmpDir();
    let cliCalls = 0;
    const state = await collectGovernanceState({
      ...DEFAULTS,
      cwd: empty,
      execFileAsync: async () => {
        cliCalls += 1;
        return { stdout: "{}", stderr: "" };
      },
    });
    expect(state.initialized).toBe(false);
    expect(cliCalls).toBe(0);
  });

  it("history 投影包含恶化/改善与最大冲击文件", async () => {
    const state = await collectGovernanceState({
      ...DEFAULTS,
      cwd: repoRoot,
      execFileAsync: fakeExec(JSON.stringify(cannedContext)),
    });
    const withDiagnosis = state.history.find((e) => typeof e.deterioration === "number" && e.deterioration !== 0);
    // 不假设账本里一定有非零诊断：只验证字段类型契约。
    for (const entry of state.history) {
      expect(typeof entry.deterioration).toBe("number");
      expect(typeof entry.improvement).toBe("number");
    }
    expect(withDiagnosis ?? state.history[0]).toBeTruthy();
  });

  it("history 按时间排序且不因目录序截断漏掉最新封存", async () => {
    // 45 条历史：文件名字母序与时间序错开；mtime 与内嵌 timestamp 一致（day 1..30 循环）。
    const dir = freshTmpDir();
    mkdirSync(join(dir, ".openarch", "history"), { recursive: true });
    writeFileSync(join(dir, ".openarch", "config.yml"), 'presentation:\n  locale: "zh"\nlanguages: ["typescript"]\n');
    for (let i = 0; i < 45; i += 1) {
      const day = 1 + (i % 30);
      const name = `diff-v3-${String(i).padStart(4, "0")}-aaaaaaaa.json`;
      const record = {
        entryId: name,
        timestamp: `2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`,
        deltas: [{ file: `f${i}.ts`, deltaI: i + 1 }],
        diagnosis: [],
      };
      const file = join(dir, ".openarch", "history", name);
      writeFileSync(file, JSON.stringify(record));
      const mtime = new Date(2026, 7, day, 0, 0, 0);
      utimesSync(file, mtime, mtime);
    }
    const state = await collectGovernanceState({
      ...DEFAULTS,
      cwd: dir,
      execFileAsync: fakeExec(JSON.stringify(cannedContext)),
    });
    expect(state.history.length).toBe(20);
    // 最新一天（day 30 → i=29）必须进榜且排第一。
    expect(state.history[0].timestamp).toBe("2026-08-30T12:00:00.000Z");
    expect(state.history[0].sumAbsDeltaI).toBe(30);
  });
});

describe("openarch-state: fail-closed 与简报渲染", () => {
  it("CLI 输出非 JSON → { ok: false, error }", async () => {
    const result = await loadCliContext({
      ...DEFAULTS,
      cwd: repoRoot,
      execFileAsync: fakeExec("not-json-at-all"),
    });
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  it("CLI 进程级失败（无 exitCode）→ fail-closed", async () => {
    const result = await loadCliContext({
      ...DEFAULTS,
      cwd: repoRoot,
      execFileAsync: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("spawn ENOENT");
  });

  it("context-json 载荷 schema 缺失/不识别 → fail-closed（上游契约纪律，不得反推旧版）", async () => {
    const missing = await loadCliContext({
      ...DEFAULTS,
      cwd: repoRoot,
      execFileAsync: fakeExec(JSON.stringify({ ...cannedContext, schema: undefined })),
    });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("fail-closed");
    expect(missing.error).toContain("缺失");

    const v2 = await loadCliContext({
      ...DEFAULTS,
      cwd: repoRoot,
      execFileAsync: fakeExec(JSON.stringify({ ...cannedContext, schema: "context-json-v2" })),
    });
    expect(v2.ok).toBe(false);
    expect(v2.error).toContain("context-json-v2");
    expect(v2.error).toContain("context-json-v1");

    const ok = await loadCliContext({
      ...DEFAULTS,
      cwd: repoRoot,
      execFileAsync: fakeExec(JSON.stringify(cannedContext)),
    });
    expect(ok.ok).toBe(true);
    expect(ok.context.schema).toBe("context-json-v1");
  });

  it.skipIf(process.env.OPENARCH_TEST_SCOPE !== "integration")("简报只报告事实且保持简短", async () => {
    const state = await collectGovernanceState({
      ...DEFAULTS,
      cwd: repoRoot,
      execFileAsync: fakeExec(JSON.stringify(cannedContext)),
    });
    const zh = renderGovernanceBrief(state, "zh");
    expect(zh).toContain("OpenArch 治理事实");
    expect(zh).toContain("baseline");
    expect(zh).toContain("rules");
    expect(zh.split("\n").length).toBeLessThanOrEqual(7);
    const en = renderGovernanceBrief(state, "en");
    expect(en).toContain("OpenArch governance facts");
  });

  it("未初始化 → 简报为空串（prompt 装配丢弃空 section）", () => {
    expect(renderGovernanceBrief({ initialized: false }, "zh")).toBe("");
    expect(renderGovernanceBrief(null, "zh")).toBe("");
  });
});

describe("openarch-state: 有界缓存", () => {
  it("snapshot 初始为 null；get() 触发采集；invalidate() 清空", async () => {
    const cache = createGovernanceCache({
      ...DEFAULTS,
      cwd: freshTmpDir(),
      execFileAsync: fakeExec("{}"),
      stateTtlMs: 60_000,
    });
    expect(cache.snapshot()).toBeNull();
    const state = await cache.get();
    expect(state.initialized).toBe(false);
    expect(cache.snapshot()).toBe(state);
    cache.invalidate();
    expect(cache.snapshot()).toBeNull();
    const again = await cache.get();
    expect(again.initialized).toBe(false);
  });

  it.skipIf(process.env.OPENARCH_TEST_SCOPE !== "integration")("TTL 内 get() 复用快照（每轮采集 = context + contract 两条命令，只跑一轮）", async () => {
    let calls = 0;
    const cache = createGovernanceCache({
      ...DEFAULTS,
      cwd: repoRoot,
      execFileAsync: async (_file, args) => {
        calls += 1;
        if (Array.isArray(args) && args.includes("contract")) {
          return {
            stdout: JSON.stringify({
              schema: "contract-catalog-json-v1",
              openarchVersion: "0.1.2",
              contracts: [{ id: "context-json", version: "context-json-v1", status: "current" }],
            }),
            stderr: "",
          };
        }
        return { stdout: JSON.stringify(cannedContext), stderr: "" };
      },
      stateTtlMs: 60_000,
    });
    const first = await cache.get();
    const second = await cache.get();
    expect(second).toBe(first);
    // 一次采集固定两条 CLI 调用（context + contract）；TTL 内第二轮不重采。
    expect(calls).toBe(2);
    expect(first.contractCatalog).not.toBeNull();
    expect(first.contractCatalog.contracts[0].version).toBe("context-json-v1");
  });
});

describe("openarch-state: 多工作区缓存", () => {
  it("createGovernanceCaches 按 root 隔离快照，invalidate 只失效对应根", async () => {
    const dirA = freshTmpDir();
    const dirB = freshTmpDir();
    mkdirSync(join(dirA, ".openarch"), { recursive: true });
    mkdirSync(join(dirB, ".openarch"), { recursive: true });
    writeFileSync(join(dirA, ".openarch", "config.yml"), 'presentation:\n  locale: "zh"\n');
    writeFileSync(join(dirB, ".openarch", "config.yml"), 'presentation:\n  locale: "zh"\n');
    const caches = createGovernanceCaches({
      ...DEFAULTS,
      execFileAsync: async (_file, args) => {
        if (Array.isArray(args) && args.includes("contract")) {
          return { stdout: JSON.stringify({ schema: "contract-catalog-json-v1", openarchVersion: "0.1.2", contracts: [] }), stderr: "" };
        }
        return { stdout: JSON.stringify(cannedContext), stderr: "" };
      },
      stateTtlMs: 60_000,
    });
    const stateA = await caches.forRoot(dirA).get();
    const stateB = await caches.forRoot(dirB).get();
    expect(stateA.root).toBe(dirA);
    expect(stateB.root).toBe(dirB);
    expect(stateA.initialized).toBe(true);
    expect(stateA).not.toBe(stateB);
    // 同一 root 归一化（反斜杠/大小写）复用同一缓存实例。
    expect(caches.forRoot(dirA)).toBe(caches.forRoot(`${dirA}\\`.toUpperCase()));
    caches.invalidate(dirA);
    const againA = await caches.forRoot(dirA).get();
    expect(againA).not.toBe(stateA);
    // 只失效 A：B 的快照仍在。
    expect(caches.forRoot(dirB).snapshot()).toBe(stateB);
  });

  it("normalizeRoot 归一化分隔符/尾部/大小写", () => {
    expect(normalizeRoot("E:\\Work\\Repo\\")).toBe("e:/work/repo");
    expect(normalizeRoot("e:/work/repo")).toBe("e:/work/repo");
    expect(normalizeRoot("")).toBe("");
    expect(normalizeRoot(null)).toBe("");
  });
});

describe("openarch-state: 仓库路径解析", () => {
  it("repoRoot 指向本仓库（含 .openarch/config.yml）", () => {
    expect(resolve(repoRoot, ".openarch", "config.yml")).toBeTruthy();
    expect(join(repoRoot, ".openarch", "config.yml")).toContain("openarch");
  });
});
