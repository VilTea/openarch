/**
 * baseline 与当前配置的**兼容性唯一权威**（D-G8③，2026-09-25 项目所有者批准）。
 *
 * 缺陷：同一件事实——"记录在 baseline 里的分析范围还是不是当前的"——曾被三处各自实现：
 * - `gateApp.baselineReadiness`（私有，返回 `GateUnavailableReason`）
 * - `status.projectGovernanceStatus` 里的 `scope` 标签（`unknown/partial/compatible/different`）
 * - `scriptFacts` 的 `scopeMatches`
 * 三份实现各自演化 ⇒ "scope 不兼容"在不同命令下的**可见性**不同：`check` 会报
 * `baseline_scope_incompatible`，而 `test` 静默继续（实测：D-G5 改了分类语义后，
 * `test` 仍照旧采集，只有 `context` 会说 scope=不匹配）。
 *
 * 本模块只回答两个投影，均由**同一组输入**算出，因此不可能互相矛盾：
 * - `scopeState`：范围是否仍然一致（供 `status` 做细粒度表述）；
 * - `compatible` + `reason`：整体可用性（供 gate / test 做门禁与覆盖判定）。
 *
 * 顺序与判据照搬 `gateApp.baselineReadiness`（本次改造**不改变 gate 行为**）：
 * 缺索引 → 范围不匹配（指纹不同**或**不完整）→ 缺快照身份 → 度量契约不兼容。
 *
 * 语言形状契约（2026-09-27 §6/Q2）：本权威**同时消费 scope 与 shapes**。
 * 声明了 shapes 的项目把 `shapesFingerprint` 写进 baseline meta；不匹配报
 * `baseline_shapes_incompatible`（与 `baseline_scope_incompatible` 同构、同一处实现）。
 * 判据放在范围之后、快照身份之前：范围决定**population**，形状决定**判断口径**
 * ——两者都比"快照身份是否存在"更基础。
 *
 * **默认零迁移**（§6/Q2 的关键收敛）：未声明 shapes 时当前指纹是 `""`；
 * 旧 baseline 记录里**没有**该字段（`undefined`）按 `""` 处理 ⇒ 二者相等 ⇒
 * 现有项目的行为与判据**逐条不变**。`shapesFingerprint` 缺省（未传）同样按 `""` 处理，
 * 因此 `status`/`scriptFacts` 等"只回答自己关心的问题"的调用方无需改动即可保持旧语义。
 */
import { METRIC_CONTRACT_VERSION } from "../domain/metricCatalog";
export interface BaselineCompatibilityInput {
  /** baseline 索引是否存在（缺失时其余字段无意义）。 */
  readonly indexPresent: boolean;
  /** baseline 记录的 scope 指纹；缺省表示记录里没有该字段（旧 baseline）。 */
  readonly recordedScopeFingerprint?: string;
  /** baseline 记录的 scope 是否完整。 */
  readonly recordedScopeComplete?: boolean;
  /** baseline 记录的 `shapesFingerprint`；缺省表示记录里没有该字段（旧 baseline）⇒ 按 `""`（未声明）。 */
  readonly recordedShapesFingerprint?: string;
  readonly recordedSnapshotIdentity?: string;
  readonly recordedMetricContractVersion?: string;
  readonly currentScopeFingerprint: string;
  /** 当前项目声明的形状指纹；缺省（未判定/未读取）按 `""`（未声明）处理。 */
  readonly currentShapesFingerprint?: string;
  readonly currentMetricContractVersion: string;
}

/** 范围一致性标签：`unknown` = 记录里没有指纹；`partial` = 记录声明范围不完整。 */
export type BaselineScopeState = "unknown" | "partial" | "compatible" | "different";

/** 形状身份一致性标签（§6/Q2）：`unknown` = 记录里没有该字段（旧 baseline，按"未声明"处理）。 */
export type BaselineShapesState = "unknown" | "compatible" | "different";

export type BaselineIncompatibilityReason =
  | "missing_baseline_index"
  | "baseline_scope_incompatible"
  | "baseline_shapes_incompatible"
  | "missing_snapshot_identity"
  | "metric_contract_incompatible";

export interface BaselineCompatibility {
  readonly scopeState: BaselineScopeState;
  /** 形状身份状态；与 scope 并列，使"哪一项不一致"在 `status` 一类消费者里可见。 */
  readonly shapesState: BaselineShapesState;
  readonly compatible: boolean;
  /** 不兼容原因；`compatible` 为 true 时缺省。 */
  readonly reason?: BaselineIncompatibilityReason;
}

/** 记录缺字段 = 未声明（`""`）；显式传入的值原样使用。 */
const shapesFingerprint = (value: string | undefined): string => value ?? "";

export const baselineCompatibility = (input: BaselineCompatibilityInput): BaselineCompatibility => {
  const scopeState: BaselineScopeState = input.recordedScopeFingerprint === undefined
    ? "unknown"
    : input.recordedScopeComplete !== true ? "partial"
      : input.recordedScopeFingerprint === input.currentScopeFingerprint ? "compatible" : "different";
  const recordedShapes = shapesFingerprint(input.recordedShapesFingerprint);
  const currentShapes = shapesFingerprint(input.currentShapesFingerprint);
  // `unknown` = 记录里没有该字段**且**当前也没声明（两边都没有"形状身份"这件事实）；
  // 一旦任一边声明了，比较就是确定的 ⇒ `compatible` 或 `different`。
  const shapesState: BaselineShapesState = recordedShapes === "" && currentShapes === ""
    ? "unknown"
    : recordedShapes === currentShapes ? "compatible" : "different";
  const reason: BaselineIncompatibilityReason | undefined = !input.indexPresent
    ? "missing_baseline_index"
    : input.recordedScopeFingerprint !== input.currentScopeFingerprint || input.recordedScopeComplete !== true
      ? "baseline_scope_incompatible"
      : recordedShapes !== currentShapes
        ? "baseline_shapes_incompatible"
        : input.recordedSnapshotIdentity === undefined
          ? "missing_snapshot_identity"
          : input.recordedMetricContractVersion !== input.currentMetricContractVersion
            ? "metric_contract_incompatible"
            : undefined;
  return reason === undefined ? { scopeState, shapesState, compatible: true } : { scopeState, shapesState, compatible: false, reason };
};

/** baseline 索引记录里与本判据相关的字段（结构化，容忍未类型化的原始 JSON）。 */
export interface BaselineIndexCompatibilityView {
  readonly meta?: {
    readonly analysisScope?: { readonly fingerprint?: unknown; readonly complete?: unknown };
    readonly shapesFingerprint?: unknown;
    readonly snapshotSha256?: unknown;
    readonly metricContractVersion?: unknown;
  };
}

/**
 * 「索引字段 → 判据输入」的映射**唯一权威**。
 *
 * 为什么需要它：判据本身收敛后，三个调用方仍会各自写一遍"从 meta 里取四个字段、缺省怎么算"
 * ——那是同一份知识的第二处实现（本次改造要消除的正是这个）。调用方只提供**当前**范围指纹。
 *
 * 兼容性说明：`recordedScopeComplete` 只在记录显式为 `true` 时才算完整（旧记录缺字段 ⇒
 * 视作不完整，与 `gateApp.baselineReadiness` 原判据一致）。
 * `currentShapesFingerprint` 缺省为 `""`（未声明）——现有调用方因此**无需改动**即保持旧语义。
 */
export const baselineCompatibilityOf = (
  index: BaselineIndexCompatibilityView | null,
  currentScopeFingerprint: string,
  currentShapesFingerprint?: string,
): BaselineCompatibility => baselineCompatibility({
  indexPresent: index !== null,
  ...(typeof index?.meta?.analysisScope?.fingerprint === "string" ? { recordedScopeFingerprint: index.meta.analysisScope.fingerprint } : {}),
  ...(index?.meta?.analysisScope?.complete === true ? { recordedScopeComplete: true } : {}),
  ...(typeof index?.meta?.shapesFingerprint === "string" ? { recordedShapesFingerprint: index.meta.shapesFingerprint } : {}),
  ...(typeof index?.meta?.snapshotSha256 === "string" ? { recordedSnapshotIdentity: index.meta.snapshotSha256 } : {}),
  ...(typeof index?.meta?.metricContractVersion === "string" ? { recordedMetricContractVersion: index.meta.metricContractVersion } : {}),
  currentScopeFingerprint,
  ...(currentShapesFingerprint === undefined ? {} : { currentShapesFingerprint }),
  currentMetricContractVersion: METRIC_CONTRACT_VERSION,
});
