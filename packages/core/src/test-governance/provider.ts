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

/** 框架 provider 负责语法事实；它不能读取项目策略或返回 gate severity。 */
export interface TestFrameworkProvider {
  readonly id: string;
  readonly supports: (file: string) => boolean;
  readonly collect: (file: string, parser: ParserService) => Promise<TestProviderResult>;
}
