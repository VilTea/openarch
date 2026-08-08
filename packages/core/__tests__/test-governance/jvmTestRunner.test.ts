import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gradleTestRunner, mavenTestRunner } from "../../src/test-governance/runners/jvmTest";

describe("JVM test runners", () => {
  it("does not execute an unrecognised build root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openarch-jvm-runner-"));
    try {
      await expect(mavenTestRunner.run(dir)).resolves.toMatchObject({ passed: false, detail: "pom.xml not found" });
      await expect(gradleTestRunner.run(dir)).resolves.toMatchObject({ passed: false, detail: "Gradle build file not found" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
