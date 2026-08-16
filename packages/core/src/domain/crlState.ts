// packages/core/src/domain/crlState.ts
// 公式 5a：存量 CRL（CRL_state）——当前代码结构的复杂度负担。
// 6 维度加权聚合，各维度以 P95 归一化。

export interface P95Values {
  readonly branch: number;                 // 单函数最大分支数 P95
  readonly nesting: number;
  readonly loc: number;                    // 去注释行数 P95
  readonly alpha: number;
  readonly oneMinusConnectedness: number;  // P95(1-connectedness)——分子分母同指标（2026-07-09 fix）
  /** 已确认的直接非本地调用 P95；成员/动态调用不计入。 */
  readonly externalPassthrough: number;
}

export interface CRLStateWeights {
  readonly branch: number;
  readonly nesting: number;
  readonly loc: number;
  readonly alpha: number;
  readonly connectedness: number;
  readonly externalPassthrough: number;
}

/** 默认权重（design v5.3 §7.3） */
export const DEFAULT_CRL_STATE_WEIGHTS: CRLStateWeights = Object.freeze({
  branch: 0.2, nesting: 0.2, loc: 0.15, alpha: 0.15, connectedness: 0.15, externalPassthrough: 0.15,
});

export interface CRLStateInput {
  readonly maxFuncBranch?: number;
  readonly nestingDepth: number;
  readonly loc?: number;
  /** 声明行（类型/接口头 + 函数签名）：loc 因子按实现行口径排除（校准 2026-08-08）。 */
  readonly declarationLoc?: number;
  readonly alphaStruct: number;
  readonly connectedness?: number;
  readonly externalPassthroughCalls?: number;
  /** 透传调用数回退（旧 parser/存量条目）；normalizeLocalBurdenInputs 统一回退。 */
  readonly passthroughCalls?: number;
}

/** crl_local 的四个原始输入，全局唯一定义（gate/review/calibration/D_MR 共用）。
 *  loc 恒为实现行口径，externalPassthrough 恒为已确认值并回退 passthroughCalls。 */
export interface LocalBurdenInputs {
  readonly maxFuncBranch: number;
  readonly nestingDepth: number;
  readonly implementationLoc: number;
  readonly externalPassthroughCalls: number;
}

export const localBurdenInputsOf = (
  m: Pick<CRLStateInput, "maxFuncBranch" | "nestingDepth" | "loc" | "declarationLoc" | "externalPassthroughCalls" | "passthroughCalls">,
): LocalBurdenInputs => ({
  maxFuncBranch: m.maxFuncBranch ?? 0,
  nestingDepth: m.nestingDepth,
  implementationLoc: Math.max(0, (m.loc ?? 0) - (m.declarationLoc ?? 0)),
  externalPassthroughCalls: m.externalPassthroughCalls ?? m.passthroughCalls ?? 0,
});

export interface CRLStateComponents {
  readonly branch: number;
  readonly nesting: number;
  readonly loc: number;
  readonly externalPassthrough: number;
  readonly alpha: number;
  readonly disconnectedness: number;
}

/**
 * 存量诊断拆分：局部负担决定 gate，暴露度和模块形态用于 review 解释。
 * 复合值保留给历史报表兼容，不能再被当作唯一的腐化结论。
 */
export interface CRLStateBreakdown {
  readonly localBurden: number;
  readonly exposure: number;
  readonly moduleShape: number;
  readonly composite: number;
  readonly components: CRLStateComponents;
}

export const computeCRLStateBreakdown = (
  m: CRLStateInput,
  p: P95Values,
  w: CRLStateWeights = DEFAULT_CRL_STATE_WEIGHTS,
): CRLStateBreakdown => {
  const safeDiv = (v: number, pval: number) => pval > 0 ? Math.min(1, v / pval) : 0;
  const conn = m.connectedness ?? 1;
  const local = localBurdenInputsOf(m);
  const components: CRLStateComponents = {
    branch: w.branch * safeDiv(local.maxFuncBranch, p.branch),
    nesting: w.nesting * safeDiv(local.nestingDepth, p.nesting),
    loc: w.loc * safeDiv(local.implementationLoc, p.loc),
    externalPassthrough: w.externalPassthrough * safeDiv(local.externalPassthroughCalls, p.externalPassthrough),
    alpha: w.alpha * safeDiv(m.alphaStruct, p.alpha),
    disconnectedness: w.connectedness * safeDiv(1 - conn, p.oneMinusConnectedness),
  };
  const localBurden = components.branch + components.nesting + components.loc + components.externalPassthrough;
  const composite = localBurden + components.alpha + components.disconnectedness;
  return { localBurden, exposure: m.alphaStruct, moduleShape: 1 - conn, composite, components };
};

/** @deprecated Gate 应使用 computeCRLStateBreakdown().localBurden。 */
export const computeCRLState = (
  m: CRLStateInput,
  p: P95Values,
  w: CRLStateWeights = DEFAULT_CRL_STATE_WEIGHTS,
): number => computeCRLStateBreakdown(m, p, w).composite;
