// packages/core/src/implicit-deps/types.ts
// 隐式依赖发现引擎的类型契约（design TD-17）。
// 管道纪律在引擎侧：引擎硬编码执行 text → ast → link，脚本只填每个 stage 的转换函数。
// 脚本输出 DiscoveredEdge[]；引擎加 source/confidence 后存为 StoredEdge。
import type { StagedRule } from "../staged-analysis/types";

/** 规则脚本产出的依赖边（不含来源/置信度——由引擎在合并时加） */
export interface DiscoveredEdge {
  readonly from: string;
  readonly to: string;
  readonly via: string;
  readonly type: string;
}

/** link 的非破坏观测（report-only，不落边）：未解析键、动态键或说明。 */
export interface DiscoveredObservation {
  readonly kind: "unresolved_key" | "dynamic_key" | "note";
  /** 相关键/通道（如 cordis:service:timer 或 ctx.get）。 */
  readonly via: string;
  readonly files: readonly string[];
  readonly message?: string;
}

/** 兼容旧契约：link 可返回边数组，也可返回 { edges, observations }。 */
export type ImplicitDependencyLinkResult =
  | readonly DiscoveredEdge[]
  | { readonly edges: readonly DiscoveredEdge[]; readonly observations?: readonly DiscoveredObservation[] };

/** 落地到 implicit-deps.yml 的边（含来源与置信度） */
export interface StoredEdge extends DiscoveredEdge {
  readonly source: string;
  readonly confidence: "confirmed" | "low";
  readonly note?: string;
}

/** Scripts describe syntax stages; the shared runtime owns traversal and invokes link last. */
export type ImplicitDependencyRule = StagedRule<ImplicitDependencyLinkResult>;
