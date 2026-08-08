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

/** 落地到 implicit-deps.yml 的边（含来源与置信度） */
export interface StoredEdge extends DiscoveredEdge {
  readonly source: string;
  readonly confidence: "confirmed" | "low";
  readonly note?: string;
}

/** Scripts describe syntax stages; the shared runtime owns traversal and invokes link last. */
export type ImplicitDependencyRule = StagedRule<DiscoveredEdge>;
