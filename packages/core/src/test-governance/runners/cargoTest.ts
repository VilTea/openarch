import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectTestExecution, TestExecutionRunner } from "../runner";
import { runProjectProcess } from "./projectProcess";

const runCargoTest = (cwd: string): Promise<ProjectTestExecution> => {
  if (!existsSync(join(cwd, "Cargo.toml"))) {
    return Promise.resolve({ command: "cargo test", passed: false, detail: "Cargo.toml not found" });
  }
  return runProjectProcess({ cwd, command: "cargo", args: ["test", "--quiet"] });
};

export const CARGO_TEST_RUNNER_ID = "cargo-test";
export const cargoTestRunner: TestExecutionRunner = { id: CARGO_TEST_RUNNER_ID, run: runCargoTest };
