import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type TestFindingExemption, type TestPolicy, type TestPolicyAction } from "../domain/testGovernance";
import { configPath, projectRoot, testGovernanceRulesDir, toAbsolute } from "../infra/paths";
import { listProjectSourceFiles, readProjectConfig, readProjectLanguages } from "../projectFiles";
import { testGovernanceProviders, testGovernanceRunners } from "../test-governance/catalog";
import { GO_TESTING_PROVIDER_ID } from "../test-governance/providers/goTesting";
import { JUNIT_PROVIDER_ID } from "../test-governance/providers/junit";
import { PYTEST_PROVIDER_ID } from "../test-governance/providers/pytest";
import { RUST_TESTING_PROVIDER_ID } from "../test-governance/providers/rustCargoTest";
import { VITEST_PROVIDER_ID } from "../test-governance/providers/vitest";
import { CARGO_TEST_RUNNER_ID } from "../test-governance/runners/cargoTest";
import { NODE_TEST_RUNNER_ID } from "../test-governance/runners/nodeTest";
import { PYTEST_RUNNER_ID } from "../test-governance/runners/pytest";
import type { TestFrameworkProvider } from "../test-governance/provider";
import type { TestExecutionRunner } from "../test-governance/runner";

interface TestGovernanceConfig {
  readonly providers?: readonly string[];
  readonly runners?: readonly string[];
  readonly rules?: Readonly<Record<string, TestPolicyAction>>;
  readonly exemptions?: readonly TestFindingExemption[];
}

interface OpenArchConfig {
  readonly test_governance?: TestGovernanceConfig;
}

export interface TestGovernanceSelection {
  readonly providers: readonly TestFrameworkProvider[];
  readonly runners: readonly TestExecutionRunner[];
  readonly errors: readonly string[];
}

export interface TestGovernanceConfiguration {
  readonly policy: TestPolicy;
  readonly providerIds: readonly string[];
  readonly runnerIds: readonly string[];
  readonly configured: boolean;
  /** D-G12：config.yml 存在但无法解析时的原因。与 `configured: false` 是**不同事实**——
   *  "你没配置"和"你的配置坏了"必须说成两句话，否则报告会替项目下一个它不知道的结论。 */
  readonly configError?: string;
}

export const loadTestGovernanceConfiguration = (): TestGovernanceConfiguration => {
  // D-G13：读取走 `readProjectConfig`（唯一权威），因此"文件不存在"与"文件读不出来"
  // 在这里就能分开表达——前者是 `configured: false`（项目没启用测试治理），
  // 后者是 `configError`（项目的事实基础不可信）。
  const read = readProjectConfig(configPath());
  if (read.status === "missing") return { policy: { rules: {} }, providerIds: [], runnerIds: [], configured: false };
  if (read.status === "invalid") {
    return {
      policy: { rules: {} }, providerIds: [], runnerIds: [], configured: false,
      configError: `${configPath()} 无法解析: ${read.error}`,
    };
  }
  const cfg = read.value as OpenArchConfig | undefined;
  const test = cfg?.test_governance ?? {};
  return {
    policy: { rules: test.rules ?? {}, exemptions: test.exemptions ?? [] },
    providerIds: test.providers ?? [], runnerIds: test.runners ?? [],
    configured: cfg?.test_governance !== undefined,
  };
};

export const testGovernanceRulePaths = (): readonly string[] => {
  const directory = testGovernanceRulesDir();
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((file) => file.endsWith(".mjs")).sort().map((file) => join(directory, file));
};

export const discoverProjectTestFiles = (): readonly string[] => {
  const root = projectRoot();
  return listProjectSourceFiles({ cwd: root, population: "test-governance" })
    .map(toAbsolute)
    .sort();
};

export interface TestGovernanceAdapterSuggestion {
  readonly providers: readonly string[];
  readonly runners: readonly string[];
}

/**
 * 按检测语言给出候选适配器；只作建议，绝不自动启用（框架选择是项目决策）。
 *
 * 缺陷（2026-09-25 实地核实，`.research/openarch-java-junit`）：本表曾用**手写字符串**拼 id，
 * 于是 `java` 建议 `"junit"`、`rust` 建议 `"rust-cargo-test"`，而 catalog 注册的是
 * `"java-junit"` / `"rust-testing"`。用户按报告照抄建议即命中
 * `selectTestGovernanceAdapters` 的"未知 provider"错误分支 ⇒ `verdict = BLOCK`、
 * 覆盖 0/256、spans UNAVAILABLE。**报告自己给的建议把自己判 BLOCK**。
 *
 * 认知点修复：id 的唯一权威是各 provider/runner 模块导出的 `*_ID` 常量，
 * 本表只引用常量，不再复写字符串；`testGovernanceSetup.test.ts` 另加
 * "建议的每个 id 都必须在 catalog 中可解析" 的回归断言（覆盖未来新增语言）。
 */
const SUGGESTED_ADAPTERS: Readonly<Record<string, TestGovernanceAdapterSuggestion>> = {
  typescript: { providers: [VITEST_PROVIDER_ID], runners: [NODE_TEST_RUNNER_ID] },
  javascript: { providers: [VITEST_PROVIDER_ID], runners: [NODE_TEST_RUNNER_ID] },
  vue: { providers: [VITEST_PROVIDER_ID], runners: [NODE_TEST_RUNNER_ID] },
  go: { providers: [GO_TESTING_PROVIDER_ID], runners: [] },
  rust: { providers: [RUST_TESTING_PROVIDER_ID], runners: [CARGO_TEST_RUNNER_ID] },
  python: { providers: [PYTEST_PROVIDER_ID], runners: [PYTEST_RUNNER_ID] },
  // Java 的 runner 是 build-tool 决策（Maven/Gradle 二者不同命令），单靠语言无法定，
  // 因此**不猜 runner**：留空比猜错更安全（猜错同样进"未知 runner"错误分支）。
  java: { providers: [JUNIT_PROVIDER_ID], runners: [] },
};

export const suggestTestGovernanceAdapters = (languages: readonly string[]): TestGovernanceAdapterSuggestion | undefined => {
  const candidates = languages.flatMap((language) => {
    const suggestion = SUGGESTED_ADAPTERS[language];
    return suggestion ? [suggestion] : [];
  });
  if (candidates.length === 0) return undefined;
  return {
    providers: [...new Set(candidates.flatMap((candidate) => candidate.providers))],
    runners: [...new Set(candidates.flatMap((candidate) => candidate.runners))],
  };
};

export const selectTestGovernanceAdapters = (
  providerIds: readonly string[],
  runnerIds: readonly string[],
): TestGovernanceSelection => {
  const errors: string[] = [];
  const providers = providerIds.flatMap((id) => {
    const provider = testGovernanceProviders[id];
    if (provider) return [provider];
    errors.push(`未知测试 provider: ${id}`);
    return [];
  });
  const runners = runnerIds.flatMap((id) => {
    const runner = testGovernanceRunners[id];
    if (runner) return [runner];
    errors.push(`未知测试 runner: ${id}`);
    return [];
  });
  return { providers, runners, errors };
};
