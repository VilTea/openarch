import type { TestCaseMetric, TestCaseSpan, TestFindingInput } from "../domain/testGovernance";
import type { TestSymbolCallEvidence } from "../domain/testAssociations";
import type { ParserService } from "../port/ParserService";

export interface TestProviderResult {
  readonly tests: readonly TestCaseMetric[];
  /** Provider-owned test-body ranges for project scripts; omitted only when this provider cannot establish them. */
  readonly testCaseSpans?: readonly TestCaseSpan[];
  readonly findings: readonly TestFindingInput[];
  /** Optional provider capability; omitted when this framework/language cannot establish direct named-import calls. */
  readonly symbolCallEvidence?: readonly TestSymbolCallEvidence[];
}

/** 跨文件断言包装调用（2026-08-12 调研落地）：测试文件 import 的 helper 模块中，
 *  导出的函数体内含精确断言 → 该函数是断言包装。由 engine 定向惰性解析并缓存。 */
export interface TestProviderContext {
  /** callee 是否为跨文件断言包装（engine 已按该测试文件的 import 目标聚合）。 */
  readonly isCrossFileWrapperCall: (callee: string) => boolean;
}

/** 框架 provider 负责语法事实；它不能读取项目策略或返回 gate severity。 */
export interface TestFrameworkProvider {
  readonly id: string;
  /** 人类可读描述（语言/框架 + 静态范围），供 `openarch test --list` 与文档展示。 */
  readonly label: string;
  readonly supports: (file: string) => boolean;
  readonly collect: (file: string, parser: ParserService, context?: TestProviderContext) => Promise<TestProviderResult>;
}
