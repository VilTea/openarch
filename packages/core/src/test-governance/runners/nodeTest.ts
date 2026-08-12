import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectTestExecution, TestExecutionRunner } from "../runner";
import { runProjectProcess } from "./projectProcess";

const nodeProject = (cwd: string): boolean => existsSync(join(cwd, "package.json"));

const execute = (cwd: string, command: string, args: readonly string[]): Promise<ProjectTestExecution> =>
  runProjectProcess({ cwd, command, args });

export const NODE_TEST_RUNNER_ID = "node-test";

/** node:test 执行器：项目声明 package.json 即可运行（node --test 是 Node 内置，无额外依赖）。 */
export const nodeTestRunner: TestExecutionRunner = {
  id: NODE_TEST_RUNNER_ID,
  run: (cwd) => {
    if (!nodeProject(cwd)) return Promise.resolve({ command: "node --test", passed: false, detail: "package.json not found" });
    return execute(cwd, "node", ["--test"]);
  },
};
