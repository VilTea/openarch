// packages/core/src/application/governance/gate.ts
//
// gate use case（design v5.3 §5.3）。
// 支持 path_class：每个文件按 config paths.pattern 匹配分类，规则对每文件单独评估。
// v5.3 CRL_state 门禁：存量 CRL 接管拦截，历史 CRL 退观察。
import { Effect } from "effect";
import { RuleService } from "../../port/RuleService";
import { computeCRLStateBreakdown, DEFAULT_CRL_STATE_WEIGHTS, type P95Values, type CRLStateWeights } from "../../domain/crlState";
import type { FileKind } from "../../domain/testGovernance";
import { participatesInPopulation } from "../../domain/fileParticipation";
import { maxFuncWeightedBranchOf, topLevelWeightedBranchOf, weightedBranchTotalOf } from "../../domain/branchMetrics";
import { classifyPath, type PathClass } from "../pathClass";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GateVerdict = "PASS" | "WARN" | "BLOCK";

export interface GateRule {
  readonly name: string;
  readonly condition: string;
  readonly level: "block" | "warn";
}

export type PathEntry = PathClass;
export { classifyPath } from "../pathClass";

export interface GateInput {
  readonly rules: readonly GateRule[];
  readonly baseline: {
    readonly branchCount?: number;
    readonly weightedBranchTotal?: number;
    readonly topLevelWeightedBranch?: number;
    readonly maxFuncBranch?: number;
    readonly nestingDepth?: number;
    readonly pathClass?: string;
  };
}

export interface GateReport {
  readonly verdict: GateVerdict;
  readonly triggered: readonly { name: string; level: string; condition: string; file?: string; observed?: Record<string, unknown> }[];
}

// ---------------------------------------------------------------------------
// Single-file gate (独立函数，不依赖 Effect——rules 已编译)
// ---------------------------------------------------------------------------

export interface CompiledRule {
  readonly name: string;
  readonly level: "block" | "warn";
  readonly evaluate: (vars: Record<string, unknown>) => boolean;
  readonly condition: string;
}

export const evaluateRules = (
  compiled: readonly CompiledRule[],
  vars: Record<string, unknown>,
  filePath?: string,
): { triggered: { name: string; level: string; condition: string; file?: string; observed?: Record<string, unknown> }[]; blocked: boolean; warned: boolean } => {
  const triggered: { name: string; level: string; condition: string; file?: string; observed?: Record<string, unknown> }[] = [];
  let blocked = false, warned = false;
  for (const r of compiled) {
    if (r.evaluate(vars)) {
      triggered.push({ ...r, file: filePath, observed: vars });
      if (r.level === "block") blocked = true; else warned = true;
    }
  }
  return { triggered, blocked, warned };
};

// ---------------------------------------------------------------------------
// Use case (Effect-based, compiles rules)
// ---------------------------------------------------------------------------

export const gate = (input: GateInput) =>
  Effect.gen(function* () {
    const ruleSvc = yield* RuleService;
    const triggered: { name: string; level: string; condition: string }[] = [];
    let blocked = false, warned = false;

    const vars: Record<string, unknown> = {
      branch_count: input.baseline.branchCount ?? 0,
      weighted_branch_total: weightedBranchTotalOf(input.baseline),
      top_level_branch: topLevelWeightedBranchOf(input.baseline),
      max_func_branch: maxFuncWeightedBranchOf(input.baseline),
      nesting_depth: input.baseline.nestingDepth ?? 0,
      path_class: input.baseline.pathClass ?? "default",
    };

    for (const rule of input.rules) {
      const compiled = yield* ruleSvc.compile(rule.name, rule.condition);
      if (compiled.evaluate(vars)) {
        triggered.push(rule);
        if (rule.level === "block") blocked = true; else warned = true;
      }
    }

    const verdict: GateVerdict = blocked ? "BLOCK" : warned ? "WARN" : "PASS";
    return { verdict, triggered };
  });

/** 按文件逐个评估（支持 path_class 分类）。
 *  对每个文件：确定 path_class → 编译并评估所有规则 → 汇总。 */
export const gatePerFile = (
  rules: readonly GateRule[],
  fileMetrics: ReadonlyArray<{
    path: string; branchCount: number; weightedBranchTotal?: number; topLevelWeightedBranch?: number; nestingDepth: number; cohesion?: number;
    functionCount?: number; loc?: number; declarationLoc?: number; passthroughCalls?: number; alphaStruct?: number; maxFuncBranch?: number;
    externalPassthroughCalls?: number; connectedness?: number;
    fileKind?: FileKind;
    language?: string;
  }>,
  paths: readonly PathEntry[],
  options?: {
    p95?: P95Values; weights?: CRLStateWeights;
  },
) =>
  Effect.gen(function* () {
    const ruleSvc = yield* RuleService;
    const allTriggered: { name: string; level: string; condition: string; file?: string; observed?: Record<string, unknown> }[] = [];
    let blocked = false, warned = false;

    const p95Vals = options?.p95;
    const weights = options?.weights ?? DEFAULT_CRL_STATE_WEIGHTS;

    // 预编译所有规则
    const compiled: CompiledRule[] = [];
    for (const r of rules) {
      const c = yield* ruleSvc.compile(r.name, r.condition);
      compiled.push({ name: r.name, level: r.level, evaluate: c.evaluate, condition: r.condition });
    }

    for (const m of fileMetrics) {
      // 测试 finding 有独立策略与 gate；不能被生产代码规则静默处罚。
      if (!participatesInPopulation(m.fileKind, "production-governance")) continue;
      const pathClass = classifyPath(m.path, paths);
      // 复合值仅供兼容诊断；CEL 规则应基于局部负担和暴露度。
      // loc 按实现行口径（校准 2026-08-08）：与 crl_inputs 保持一致，保证 breakdown == crl_local。
      const breakdown = p95Vals ? computeCRLStateBreakdown({
        maxFuncBranch: m.maxFuncBranch, nestingDepth: m.nestingDepth,
        loc: m.loc, declarationLoc: m.declarationLoc, alphaStruct: m.alphaStruct ?? 0,
        connectedness: m.connectedness,
        externalPassthroughCalls: m.externalPassthroughCalls, passthroughCalls: m.passthroughCalls,
      }, p95Vals, weights) : undefined;

      const vars: Record<string, unknown> = {
        weighted_branch_total: weightedBranchTotalOf(m),
        top_level_branch: topLevelWeightedBranchOf(m),
        max_func_branch: maxFuncWeightedBranchOf(m),
        nesting_depth: m.nestingDepth,
        path_class: pathClass,
        crl_local: breakdown?.localBurden ?? 0,   // 局部负担：存量 gate 主信号
        exposure: breakdown?.exposure ?? 0,       // 反向 Reach 暴露度：组合条件信号
        module_shape: breakdown?.moduleShape ?? 0, // 不连通形态：review 诊断信号（report-only）
        loc: m.loc ?? 0,
        declaration_loc: m.declarationLoc ?? 0,   // 定义面规模（report-only）
        language: m.language ?? "unknown",
      };
      const result = evaluateRules(compiled, vars, m.path);
      for (const t of result.triggered) allTriggered.push({ ...t, observed: { ...t.observed, p95: p95Vals ?? null, weights } });
      if (result.blocked) blocked = true;
      if (result.warned) warned = true;
    }

    const verdict: GateVerdict = blocked ? "BLOCK" : warned ? "WARN" : "PASS";
    return { verdict, triggered: allTriggered };
  });
