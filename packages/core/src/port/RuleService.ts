// packages/core/src/port/RuleService.ts
import { Context, Effect } from "effect";

/** CEL-like 表达式编译结果（Phase 1 最小子集：> < >= <= == != && ||，数字/字符串字面量，标识符） */
export interface CompiledRule {
  readonly name: string;
  readonly evaluate: (vars: Record<string, unknown>) => boolean;
  /** 编译时错误信息（用于 fail-fast exit 3） */
  readonly errors?: readonly string[];
}

/** Port：规则引擎（解释器模式）。Phase 1 手写求值器，Phase 3 可换 google/cel-go */
export interface RuleService {
  /** 编译 CEL 表达式（失败则 fail-fast exit 3） */
  readonly compile: (name: string, condition: string) => Effect.Effect<CompiledRule, RuleCompileError>;
}

export const RuleService = Context.GenericTag<"RuleService", RuleService>("RuleService");

export class RuleCompileError {
  readonly _tag = "RuleCompileError";
  constructor(
    readonly expr: string,
    readonly message: string,
  ) {}
}
