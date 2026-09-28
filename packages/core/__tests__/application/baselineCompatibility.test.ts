import { describe, expect, it } from "vitest";
import { baselineCompatibility, baselineCompatibilityOf } from "../../src/application/baselineCompatibility";
import { assessTestGovernanceCoverage } from "../../src/domain/testGovernanceCoverage";

/**
 * D-G8③（2026-09-25 项目所有者批准）：baseline 兼容性此前有三份实现
 * （`gateApp.baselineReadiness` 私有、`status` 的 scope 标签、`scriptFacts.scopeMatches`），
 * 于是"scope 不兼容"在不同命令下可见性不同——`check` 会报，`test` 静默继续。
 *
 * 本测试锁住两件事：判据顺序与 gate 原实现**逐条一致**；`test` 的 coverage 消费同一判据。
 */
const indexWith = (meta: Record<string, unknown> | undefined) => ({ meta }) as never;

describe("baselineCompatibility（唯一权威）", () => {
  const current = { currentScopeFingerprint: "scope-v3:now", currentMetricContractVersion: "metric-contract-v5" };

  it("keeps the original gate order: index → scope → snapshot identity → metric contract", () => {
    expect(baselineCompatibility({ indexPresent: false, ...current })).toMatchObject({ compatible: false, reason: "missing_baseline_index" });
    expect(baselineCompatibility({ indexPresent: true, recordedScopeFingerprint: "scope-v3:old", recordedScopeComplete: true, ...current }))
      .toMatchObject({ compatible: false, reason: "baseline_scope_incompatible" });
    // 范围不完整（旧 baseline 缺 complete）同样算不兼容，与原实现一致
    expect(baselineCompatibility({ indexPresent: true, recordedScopeFingerprint: "scope-v3:now", ...current }))
      .toMatchObject({ compatible: false, reason: "baseline_scope_incompatible" });
    expect(baselineCompatibility({ indexPresent: true, recordedScopeFingerprint: "scope-v3:now", recordedScopeComplete: true, ...current }))
      .toMatchObject({ compatible: false, reason: "missing_snapshot_identity" });
    expect(baselineCompatibility({
      indexPresent: true, recordedScopeFingerprint: "scope-v3:now", recordedScopeComplete: true,
      recordedSnapshotIdentity: "sha", recordedMetricContractVersion: "metric-contract-v4", ...current,
    })).toMatchObject({ compatible: false, reason: "metric_contract_incompatible" });
    expect(baselineCompatibility({
      indexPresent: true, recordedScopeFingerprint: "scope-v3:now", recordedScopeComplete: true,
      recordedSnapshotIdentity: "sha", recordedMetricContractVersion: "metric-contract-v5", ...current,
    })).toMatchObject({ scopeState: "compatible", compatible: true });
  });

  it("projects the four scope labels status renders (unknown/partial/compatible/different)", () => {
    const scopeStateOf = (meta: Record<string, unknown> | undefined) =>
      baselineCompatibilityOf(indexWith(meta), "scope-v3:now").scopeState;
    expect(scopeStateOf(undefined)).toBe("unknown");
    expect(scopeStateOf({ analysisScope: { complete: true } })).toBe("unknown");
    expect(scopeStateOf({ analysisScope: { fingerprint: "scope-v3:now" } })).toBe("partial");
    expect(scopeStateOf({ analysisScope: { fingerprint: "scope-v3:now", complete: true } })).toBe("compatible");
    expect(scopeStateOf({ analysisScope: { fingerprint: "scope-v3:old", complete: true } })).toBe("different");
  });

  it("maps index fields in one place (recordedScopeComplete only when explicitly true)", () => {
    // complete 显式 false / 缺字段都视作不完整（旧记录兼容）
    expect(baselineCompatibilityOf(indexWith({ analysisScope: { fingerprint: "scope-v3:now", complete: false } }), "scope-v3:now").reason)
      .toBe("baseline_scope_incompatible");
    expect(baselineCompatibilityOf(null, "scope-v3:now").reason).toBe("missing_baseline_index");
  });
});

describe("语言形状身份（§6/Q2）：同一权威同时消费 scope 与 shapes", () => {
  const base = {
    indexPresent: true, recordedScopeFingerprint: "scope-v3:now", recordedScopeComplete: true,
    recordedSnapshotIdentity: "sha", recordedMetricContractVersion: "metric-contract-v5",
    currentScopeFingerprint: "scope-v3:now", currentMetricContractVersion: "metric-contract-v5",
  };
  const shapes = "typescript:weak_assertion_methods:toBeFalsy,toBeTruthy";

  it("reports baseline_shapes_incompatible while baseline_scope_incompatible keeps its own semantics", () => {
    // 声明了 shapes，但 baseline 里没有该字段（旧 baseline）⇒ 形状身份确实不同，报不兼容。
    expect(baselineCompatibility({ ...base, currentShapesFingerprint: shapes }))
      .toMatchObject({ compatible: false, reason: "baseline_shapes_incompatible", shapesState: "different" });
    // 声明改变（记录里有、当前不同）⇒ 同样报形状不兼容，并标 different。
    expect(baselineCompatibility({ ...base, recordedShapesFingerprint: "typescript:weak_assertion_methods:toBeTruthy", currentShapesFingerprint: shapes }))
      .toMatchObject({ compatible: false, reason: "baseline_shapes_incompatible", shapesState: "different" });
    // 范围先判：范围不匹配时理由仍是 `baseline_scope_incompatible`（语义未被形状改写）。
    expect(baselineCompatibility({
      ...base, recordedScopeFingerprint: "scope-v3:old", recordedShapesFingerprint: "old:shapes", currentShapesFingerprint: shapes,
    })).toMatchObject({ compatible: false, reason: "baseline_scope_incompatible", scopeState: "different", shapesState: "different" });
  });

  it("keeps existing projects at zero change: no declaration and no recorded field are the same fact", () => {
    // 旧 baseline（无字段）+ 当前未声明 ⇒ 完全兼容（这是"零迁移"的判据级证据）。
    expect(baselineCompatibility(base)).toEqual({ scopeState: "compatible", shapesState: "unknown", compatible: true });
    // 声明未变 ⇒ 兼容；`baselineCompatibilityOf` 的两参数调用（status/scriptFacts 等）按
    // 当前未声明处理，因此不传第三个参数不会凭空产生形状不兼容。
    const recorded = { meta: { analysisScope: { fingerprint: "scope-v3:now", complete: true }, shapesFingerprint: shapes, snapshotSha256: "sha", metricContractVersion: "metric-contract-v5" } };
    expect(baselineCompatibilityOf(recorded, "scope-v3:now", shapes)).toMatchObject({ compatible: true, shapesState: "compatible" });
    expect(baselineCompatibilityOf(recorded, "scope-v3:now")).toMatchObject({ compatible: false, reason: "baseline_shapes_incompatible" });
    expect(baselineCompatibilityOf(recorded, "scope-v3:now", shapes).scopeState).toBe("compatible");
  });
});

describe("test governance coverage 消费同一判据（D-G8③）", () => {
  const base = {
    configured: true, activeProviderCount: 1,
    testFiles: ["tests/a.test.ts"], unbaselinedTestFiles: [],
    providerHandledTestFiles: ["tests/a.test.ts"], unrecognizedTestFiles: [], failedTestFiles: [],
  };

  it("downgrades coverage to partial with an actionable reason when the baseline scope moved", () => {
    const coverage = assessTestGovernanceCoverage({ ...base, baselineScopeCompatible: false });
    expect(coverage.status).toBe("partial");
    expect(coverage.reasons).toEqual(["baseline_scope_incompatible"]);
    // 未判定时不声称不兼容（缺省不得变成假警报）
    expect(assessTestGovernanceCoverage(base)).toMatchObject({ status: "available", reasons: [] });
  });

  it("keeps unavailable stronger than partial, but still reports the scope reason", () => {
    const coverage = assessTestGovernanceCoverage({ ...base, providerHandledTestFiles: [], baselineScopeCompatible: false });
    expect(coverage.status).toBe("unavailable");
    expect(coverage.reasons).toContain("baseline_scope_incompatible");
  });

  it("downgrades coverage with a distinct reason when the shapes identity moved (not merged into scope)", () => {
    const coverage = assessTestGovernanceCoverage({ ...base, baselineShapesCompatible: false });
    expect(coverage.status).toBe("partial");
    expect(coverage.reasons).toEqual(["baseline_shapes_incompatible"]);
    // 两种不兼容同时成立时各自可读，不互相吞并。
    expect(assessTestGovernanceCoverage({ ...base, baselineScopeCompatible: false, baselineShapesCompatible: false }).reasons)
      .toEqual(["baseline_scope_incompatible", "baseline_shapes_incompatible"]);
  });
});
