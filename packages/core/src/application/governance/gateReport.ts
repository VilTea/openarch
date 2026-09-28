// Gate report facts are presentation-neutral. CLI owns natural-language rendering.
import type { CRLStateWeights, P95Values } from "../../domain/crlState";
import type { MaxFuncBranchOwner } from "../../domain/ast";
import type { FileKind } from "../../domain/testGovernance";
import type { GateTrigger } from "./gate";

export interface GateFileMetric {
  readonly path: string;
  readonly language?: string;
  readonly branchCount: number;
  readonly weightedBranchTotal?: number;
  readonly topLevelWeightedBranch?: number;
  readonly nestingDepth: number;
  readonly alphaStruct: number;
  /** @deprecated CT 已 cut；仅旧调用/测试兼容，不作为 gate 或报告信号。 */
  readonly cohesion?: number;
  readonly loc?: number;
  /** 声明行（类型/接口头 + 函数签名）：CRL loc 因子按实现行口径排除（校准 2026-08-08）。 */
  readonly declarationLoc?: number;
  readonly passthroughCalls?: number;
  readonly maxFuncBranch?: number;
  /** 最大加权分支的归属与形态（report-only）：让 WARN 说出是哪个函数、权重由什么构成。 */
  readonly maxFuncBranchOwner?: MaxFuncBranchOwner;
  readonly externalPassthroughCalls?: number;
  readonly connectedness?: number;
  /** 单调用点助手占比（report-only，与 connectedness 同源的内部调用图形状投影）。 */
  readonly singleCallSiteRatio?: number;
  readonly localBurdenFingerprint?: string;
  readonly previousLocalBurdenFingerprint?: string;
  readonly fileKind?: FileKind;
}

export interface GateRenderResult {
  readonly verdict: string;
  readonly triggered: readonly GateTrigger[];
}

/**
 * 阈值可见性（report-only，校准 2026-09-25）：报告里同时给出
 * 「已声明阈值 / 当前 P95」倍数与超阈文件数，避免校准依据随指标与总体演进悄悄过期
 * （历史症状：配置注释写着"设为 >6 容忍约 5%"，治理后 >6 只剩约 1%，而没有任何提示）。
 * 没有 P95 口径的 gate 指标（如 `crl_local` 是复合值）只给超阈计数，不臆造倍数。
 */
export interface GateThresholdFact {
  readonly policyId: string;
  readonly rule: string;
  readonly metricId: string;
  readonly comparison: ">" | ">=" | "<" | "<=";
  readonly threshold: number;
  readonly p95?: number;
  /** threshold / p95；P95 缺失或非正时为 undefined。 */
  readonly ratio?: number;
  /**
   * D5（2026-09-27）：`threshold / 当前观察 P95`。
   *
   * `ratio` 用的是**封存**校准的 P95（gate 就用它裁决），因此"倍数漂移"这件事此前在报告里
   * 只有间接迹象（`CALIBRATION_SHIFT` 报的是文件级局部负担与规则集变化，不是倍数）。
   * 这个槽位把**同一阈值的两个倍数**并列出来，让"校准注释与总体是否脱节"当场可读。
   * report-only：不参与裁决、不进任何指纹、两侧 P95 缺失时一律缺失（不写 0）。
   */
  readonly observedRatio?: number;
  readonly overThresholdFiles: number;
  readonly evaluatedFiles: number;
}

export interface GateReportFacts {
  readonly result: GateRenderResult;
  readonly metrics: readonly GateFileMetric[];
  readonly report: boolean;
  readonly p95: P95Values | undefined;
  readonly weights: CRLStateWeights;
  readonly policies?: readonly { readonly id: string; readonly mode: "observe" | "enforce"; readonly languages: readonly string[]; readonly evaluatedFiles: number }[];
  readonly thresholds?: readonly GateThresholdFact[];
}

export const gateReportFacts = (
  result: GateRenderResult,
  metrics: readonly GateFileMetric[],
  report: boolean,
  p95: P95Values | undefined,
  weights: CRLStateWeights,
  policies?: GateReportFacts["policies"],
  thresholds?: readonly GateThresholdFact[],
): GateReportFacts => ({ result, metrics, report, p95, weights, policies, ...(thresholds && thresholds.length > 0 ? { thresholds } : {}) });
