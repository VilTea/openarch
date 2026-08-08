import { p95 } from "./p95";
import type { TestCaseMetric } from "./testGovernance";

/** Provider 的断言和 mock 语义并不相同，因此测试 P95 只能在同一 provider 内观察。 */
export interface TestProviderSummary {
  readonly providerId: string;
  readonly testFiles: number;
  readonly testCases: number;
  /** 没有已识别测试用例时保持 unavailable，不能把未知统计成零。 */
  readonly p95?: {
    readonly loc: number;
    readonly assertionCount: number;
    readonly mockCount: number;
    /** 仅当本轮该 provider 的每个已识别测试都提供该 v2 事实时可用。 */
    readonly testBodyControlFlow?: number;
  };
}

export interface CollectedTestFacts {
  readonly providerId: string;
  readonly tests: readonly TestCaseMetric[];
}

/** 仅汇总本轮 provider 成功采集的原始事实，不生成维护负担或质量评分。 */
export const summarizeTestFacts = (facts: readonly CollectedTestFacts[]): readonly TestProviderSummary[] => {
  const grouped = new Map<string, { testFiles: number; tests: TestCaseMetric[] }>();
  for (const fact of facts) {
    const current = grouped.get(fact.providerId) ?? { testFiles: 0, tests: [] };
    current.testFiles += 1;
    current.tests.push(...fact.tests);
    grouped.set(fact.providerId, current);
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([providerId, group]) => {
    const allControlFlowAvailable = group.tests.every((test) => test.testBodyControlFlow !== undefined);
    return {
      providerId,
      testFiles: group.testFiles,
      testCases: group.tests.length,
      p95: group.tests.length === 0 ? undefined : {
        loc: p95(group.tests.map((test) => test.loc)),
        assertionCount: p95(group.tests.map((test) => test.assertionCount)),
        mockCount: p95(group.tests.map((test) => test.mockCount)),
        ...(allControlFlowAvailable ? { testBodyControlFlow: p95(group.tests.map((test) => test.testBodyControlFlow!)) } : {}),
      },
    };
  });
};
