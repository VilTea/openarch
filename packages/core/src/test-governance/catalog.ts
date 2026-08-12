import type { TestFrameworkProvider } from "./provider";
import type { TestExecutionRunner } from "./runner";
import { vitestProvider } from "./providers/vitest";
import { nodeTestProvider } from "./providers/nodeTest";
import { goTestingProvider } from "./providers/goTesting";
import { rustCargoTestProvider } from "./providers/rustCargoTest";
import { cargoTestRunner } from "./runners/cargoTest";
import { junitProvider } from "./providers/junit";
import { pytestProvider } from "./providers/pytest";
import { pytestRunner } from "./runners/pytest";
import { nodeTestRunner } from "./runners/nodeTest";
import { gradleTestRunner, mavenTestRunner } from "./runners/jvmTest";

const byId = <Item extends { readonly id: string }>(items: readonly Item[]): Readonly<Record<string, Item>> => {
  const result: Record<string, Item> = {};
  for (const item of items) {
    if (result[item.id]) throw new Error(`duplicate test-governance catalog id: ${item.id}`);
    result[item.id] = item;
  }
  return Object.freeze(result);
};

/** Product-supported adapters are registered here; application code only selects and orchestrates them. */
export const testGovernanceProviders = byId<TestFrameworkProvider>([
  vitestProvider,
  nodeTestProvider,
  goTestingProvider,
  rustCargoTestProvider,
  junitProvider,
  pytestProvider,
]);

export const testGovernanceRunners = byId<TestExecutionRunner>([cargoTestRunner, mavenTestRunner, gradleTestRunner, pytestRunner, nodeTestRunner]);

/** 注册的 provider 清单（id + label），供 `openarch test --list` 展示；顺序即 catalog 注册序。 */
export const testGovernanceProviderList = (): ReadonlyArray<{ readonly id: string; readonly label: string }> =>
  Object.values(testGovernanceProviders).map((provider) => ({ id: provider.id, label: provider.label }));
