import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { type TestFindingExemption, type TestPolicy, type TestPolicyAction } from "../domain/testGovernance";
import { configPath, projectRoot, testGovernanceRulesDir, toAbsolute } from "../infra/paths";
import { listProjectSourceFiles, readProjectLanguages } from "../projectFiles";
import { testGovernanceProviders, testGovernanceRunners } from "../test-governance/catalog";
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

export const loadTestGovernanceConfiguration = (): { readonly policy: TestPolicy; readonly providerIds: readonly string[]; readonly runnerIds: readonly string[]; readonly configured: boolean } => {
  try {
    const cfg = load(readFileSync(configPath(), "utf8")) as OpenArchConfig;
    const test = cfg.test_governance ?? {};
    return { policy: { rules: test.rules ?? {}, exemptions: test.exemptions ?? [] }, providerIds: test.providers ?? [], runnerIds: test.runners ?? [], configured: cfg.test_governance !== undefined };
  } catch {
    return { policy: { rules: {} }, providerIds: [], runnerIds: [], configured: false };
  }
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

/** 按检测语言给出候选适配器；只作建议，绝不自动启用（框架选择是项目决策）。 */
const SUGGESTED_ADAPTERS: Readonly<Record<string, TestGovernanceAdapterSuggestion>> = {
  typescript: { providers: ["typescript-vitest"], runners: ["node-test"] },
  javascript: { providers: ["typescript-vitest"], runners: ["node-test"] },
  vue: { providers: ["typescript-vitest"], runners: ["node-test"] },
  go: { providers: ["go-testing"], runners: [] },
  rust: { providers: ["rust-cargo-test"], runners: ["cargo-test"] },
  python: { providers: ["python-pytest"], runners: ["pytest"] },
  java: { providers: ["junit"], runners: [] },
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
