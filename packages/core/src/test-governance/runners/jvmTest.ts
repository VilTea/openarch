import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectTestExecution, TestExecutionRunner } from "../runner";
import { runProjectProcess } from "./projectProcess";

const execute = (cwd: string, command: string, args: readonly string[]): Promise<ProjectTestExecution> =>
  runProjectProcess({ cwd, command, args });

export const MAVEN_TEST_RUNNER_ID = "maven-test";
export const GRADLE_TEST_RUNNER_ID = "gradle-test";

export const mavenTestRunner: TestExecutionRunner = {
  id: MAVEN_TEST_RUNNER_ID,
  run: (cwd) => existsSync(join(cwd, "pom.xml"))
    ? execute(cwd, existsSync(join(cwd, process.platform === "win32" ? "mvnw.cmd" : "mvnw")) ? (process.platform === "win32" ? ".\\mvnw.cmd" : "./mvnw") : "mvn", ["test", "-q"])
    : Promise.resolve({ command: "mvn test -q", passed: false, detail: "pom.xml not found" }),
};

export const gradleTestRunner: TestExecutionRunner = {
  id: GRADLE_TEST_RUNNER_ID,
  run: (cwd) => {
    const hasBuild = existsSync(join(cwd, "build.gradle")) || existsSync(join(cwd, "build.gradle.kts"));
    if (!hasBuild) return Promise.resolve({ command: "gradle test --quiet --no-daemon", passed: false, detail: "Gradle build file not found" });
    const wrapper = process.platform === "win32" ? "gradlew.bat" : "gradlew";
    return execute(cwd, existsSync(join(cwd, wrapper)) ? (process.platform === "win32" ? ".\\gradlew.bat" : "./gradlew") : "gradle", ["test", "--quiet", "--no-daemon"]);
  },
};
