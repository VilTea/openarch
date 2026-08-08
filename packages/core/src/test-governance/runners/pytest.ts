import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectTestExecution, TestExecutionRunner } from "../runner";
import { runProjectProcess } from "./projectProcess";

const pytestProject = (cwd: string): boolean =>
  ["pyproject.toml", "pytest.ini", "tox.ini", "setup.cfg"].some((file) => existsSync(join(cwd, file)));

const execute = (cwd: string, command: string, args: readonly string[]): Promise<ProjectTestExecution> =>
  runProjectProcess({ cwd, command, args });

export const PYTEST_RUNNER_ID = "pytest";

/** Uses uv only when the project declares its lock; other Python environment managers stay explicit project choices. */
export const pytestRunner: TestExecutionRunner = {
  id: PYTEST_RUNNER_ID,
  run: (cwd) => {
    if (!pytestProject(cwd)) return Promise.resolve({ command: "python -m pytest -q", passed: false, detail: "pytest project configuration not found" });
    return existsSync(join(cwd, "uv.lock")) ? execute(cwd, "uv", ["run", "pytest", "-q"]) : execute(cwd, "python", ["-m", "pytest", "-q"]);
  },
};
