// packages/core/src/domain/crl.ts
// 公式5：累积职责负荷（design v5.2 §7.3）
// λ = ln(2)/60，半衰期 60 天。指数衰减——唯一具有"无记忆性"的衰减函数。

/** 半衰期 60 天的指数衰减常数 */
const LAMBDA_60D = Math.log(2) / 60;

/** 单条 history entry（与 .openarch/history/*.json 结构一致） */
export interface HistoryEntry {
  readonly timestamp: string; // ISO 8601
  readonly deltas: readonly FileDelta[];
}

export interface FileDelta {
  readonly file: string;
  readonly deltaI: number; // 本次对该文件的 I_push 贡献
  /** Report-only structural context for an idempotent diff replay; CRL ignores it. */
  readonly alphaStruct?: number;
}

/** 显式 diff 对源码内容作出的可验证声明；不存源码，只存路径、语义类别和摘要。 */
export interface SemanticEvidence {
  readonly file: string;
  /** Stable declaration/import anchor; absent on legacy history entries. */
  readonly anchor?: string;
  readonly changeKind: string;
  readonly sha256: string;
}

/** 文件级 CRL（用于 gate WARN/ASK）
 *  CRL_file(p, t) = Σ_{i=1..M} ΔI_i × e^(-λ × (t - t_i))
 *  t = 当前日期距 1970-01-01 的天数，t_i = push 发生时的天数
 */
export const computeCrl = (
  history: readonly HistoryEntry[],
  now = new Date(),
): ReadonlyMap<string, number> => {
  const crl = new Map<string, number>();
  const today = now.getTime() / 86_400_000; // ms → days

  for (const entry of history) {
    const entryDay = new Date(entry.timestamp).getTime() / 86_400_000;
    // Clock rollback or a future-dated record must not amplify a contribution.
    // Keep the record observable while treating it as observed at `now`.
    const age = Math.max(0, today - entryDay); // 距今天数
    const decay = Math.exp(-LAMBDA_60D * age);

    for (const d of entry.deltas) {
      const prev = crl.get(d.file) ?? 0;
      crl.set(d.file, prev + d.deltaI * decay);
    }
  }

  return crl;
};
