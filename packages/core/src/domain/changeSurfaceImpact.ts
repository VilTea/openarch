// packages/core/src/domain/changeSurfaceImpact.ts
/**
 * 变更面冲击（C_push, design v5.2 扩展，规格 2026-08-03-change-surface-impact.md）。
 *
 * 与 I_push（变更文件的冲击，文件级 inDegree）互补：C_push 衡量「被修改符号
 * 的消费者冲击面」——变更符号被多少跨文件消费者引用，以及消费侧所在层的权重。
 *
 * 只接受符号级证据（provenance = "symbol" 或静态上界为空时的 "static-bound-empty"）。
 * 工具链不可用时**不输出 C_push 数值**（规格 §3.3：无 file-graph 兜底，不误导 agent）；
 * 由编排层输出 unavailable。静态上界为空（无文件 import 变更文件）是逻辑必然的 0 消费者，
 * 无需 LSP（规格 §3.4 预筛）。
 */
import { LAMBDA_AST, type ChangeKind } from "./weights";

export type ChangeSurfaceProvenance = "symbol" | "static-bound-empty";

export interface ChangeSurfaceContribution {
  /** 变更声明 anchor（与 SemanticChange.anchor 一致，如 "Foo.bar" / "import:src"） */
  readonly anchor: string;
  readonly kind: ChangeKind;
  readonly lambdaAst: number;
  /** 去重后的跨文件消费者文件列表 */
  readonly consumers: readonly string[];
  readonly reachFactor: number;
  /** 消费者文件路径类权重中的 max（最严重消费者决定冲击，从严） */
  readonly layerWeight: number;
  readonly contribution: number;
  /** 静态上界非空但符号级 0 消费者：结果是待确认（unconfirmed）而非结论 0（规格 §3.6）。 */
  readonly unconfirmed: boolean;
}

export interface ChangeSurfaceResult {
  readonly provenance: ChangeSurfaceProvenance;
  readonly contributions: readonly ChangeSurfaceContribution[];
  readonly total: number;
  readonly consumersByAnchor: ReadonlyMap<string, readonly string[]>;
}

export interface ChangeSurfaceInput {
  readonly provenance: ChangeSurfaceProvenance;
  readonly changes: readonly { readonly anchor: string; readonly kind: ChangeKind }[];
  readonly consumersByAnchor: ReadonlyMap<string, readonly string[]>;
  readonly layerWeightOf: (file: string) => number;
  /** Anchors whose static upper bound is non-empty but symbol-level consumers are zero
   *  (unconfirmed, not a zero-impact conclusion - spec §3.6). */
  readonly unconfirmedAnchors?: readonly string[];
}

const unique = (files: readonly string[]): readonly string[] => [...new Set(files)];

/**
 * 纯函数：按变更符号聚合消费者冲击。
 * - consumers 按文件去重；
 * - reachFactor = log2(|consumers|+1)，0 消费者 → 0 贡献（无冲击面事实，不算冲击）；
 * - layerWeight = max(消费者文件路径类权重)；
 * - contribution = λ_ast × reachFactor × layerWeight。
 */
export const computeChangeSurfaceImpact = (input: ChangeSurfaceInput): ChangeSurfaceResult => {
  const unconfirmed = new Set(input.unconfirmedAnchors ?? []);
  const contributions = input.changes.map((change) => {
    const consumers = unique(input.consumersByAnchor.get(change.anchor) ?? []);
    const reachFactor = Math.log2(consumers.length + 1);
    const layerWeight = consumers.length > 0 ? Math.max(...consumers.map(input.layerWeightOf)) : 0;
    return {
      anchor: change.anchor,
      kind: change.kind,
      lambdaAst: LAMBDA_AST[change.kind] ?? 0,
      consumers,
      reachFactor,
      layerWeight,
      contribution: (LAMBDA_AST[change.kind] ?? 0) * reachFactor * layerWeight,
      unconfirmed: unconfirmed.has(change.anchor),
    } satisfies ChangeSurfaceContribution;
  });
  const total = contributions.reduce((sum, c) => sum + c.contribution, 0);
  return {
    provenance: input.provenance,
    contributions,
    total,
    consumersByAnchor: input.consumersByAnchor,
  };
};
