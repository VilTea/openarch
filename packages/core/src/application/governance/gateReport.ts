// Gate report facts are presentation-neutral. CLI owns natural-language rendering.
import type { CRLStateWeights, P95Values } from "../../domain/crlState";
import type { FileKind } from "../../domain/testGovernance";

export interface GateFileMetric {
  readonly path: string;
  readonly language?: string;
  readonly branchCount: number;
  readonly weightedBranchTotal?: number;
  readonly topLevelWeightedBranch?: number;
  readonly nestingDepth: number;
  readonly alphaStruct: number;
  readonly cohesion: number;
  readonly loc?: number;
  /** 声明行（类型/接口头 + 函数签名）：CRL loc 因子按实现行口径排除（校准 2026-08-08）。 */
  readonly declarationLoc?: number;
  readonly passthroughCalls?: number;
  readonly maxFuncBranch?: number;
  readonly externalPassthroughCalls?: number;
  readonly connectedness?: number;
  readonly localBurdenFingerprint?: string;
  readonly previousLocalBurdenFingerprint?: string;
  readonly fileKind?: FileKind;
}

export interface GateRenderResult {
  readonly verdict: string;
  readonly triggered: readonly { name: string; level: string; condition: string; file?: string; observed?: Record<string, unknown> }[];
}

export interface GateReportFacts {
  readonly result: GateRenderResult;
  readonly metrics: readonly GateFileMetric[];
  readonly report: boolean;
  readonly p95: P95Values | undefined;
  readonly weights: CRLStateWeights;
  readonly policies?: readonly { readonly id: string; readonly mode: "observe" | "enforce"; readonly languages: readonly string[]; readonly evaluatedFiles: number }[];
}

export const gateReportFacts = (
  result: GateRenderResult,
  metrics: readonly GateFileMetric[],
  report: boolean,
  p95: P95Values | undefined,
  weights: CRLStateWeights,
  policies?: GateReportFacts["policies"],
): GateReportFacts => ({ result, metrics, report, p95, weights, policies });
