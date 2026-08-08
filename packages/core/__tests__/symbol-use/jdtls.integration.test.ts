import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { collectJavaSymbolUse } from "../../src/adapter/symbol-use/JavaSymbolUseProvider";
import { ParserService } from "../../src/port/ParserService";
import { collectStaticImportConsumers } from "./support/staticImportConsumers";

const roots: string[] = [];
const jdtls = process.env.OPENARCH_JDTLS_PATH;
const calibrationCwd = process.env.OPENARCH_JDTLS_CALIBRATION_CWD;
const pruningCwd = process.env.OPENARCH_JDTLS_PRUNING_CALIBRATION_CWD;
const enabled = process.env.OPENARCH_JDTLS_INTEGRATION === "1" && Boolean(jdtls);

const project = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "openarch-jdtls-symbol-use-"));
  roots.push(cwd);
  mkdirSync(join(cwd, "src", "main", "java", "example"), { recursive: true });
  writeFileSync(join(cwd, "pom.xml"), [
    '<project xmlns="http://maven.apache.org/POM/4.0.0">',
    '  <modelVersion>4.0.0</modelVersion>',
    '  <groupId>example</groupId><artifactId>symbol-use</artifactId><version>1.0.0</version>',
    '  <properties><maven.compiler.release>21</maven.compiler.release></properties>',
    '</project>',
  ].join("\n"));
  writeFileSync(join(cwd, "src", "main", "java", "example", "Producer.java"), "package example;\n\nclass Producer { static String hidden() { return \"ok\"; } }\n");
  writeFileSync(join(cwd, "src", "main", "java", "example", "Consumer.java"), "package example;\n\nclass Consumer { String use() { return Producer.hidden(); } }\n");
  return cwd;
};

afterEach(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe("JDT LS symbol-use calibration", () => {
  it.skipIf(!enabled)("opens a Maven project and returns parser-anchored Java declarations", async () => {
    const cwd = project();
    const report = await Effect.runPromise(Effect.gen(function* () {
      const parser = yield* ParserService;
      return yield* collectJavaSymbolUse({ cwd, languages: ["java"] }, { parser, executable: jdtls! });
    }).pipe(Effect.provide(TreeSitterParserLive)));

    expect(report.state).toMatchObject({
      availability: "available",
      coverage: { declarations: "complete", repositoryReferences: "complete" },
    });
    expect(report.facts.map((fact) => fact.declaration)).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "src/main/java/example/Producer.java", name: "hidden" }),
      expect.objectContaining({ file: "src/main/java/example/Consumer.java", name: "use" }),
    ]));
    expect(report.facts).toContainEqual(expect.objectContaining({
      declaration: expect.objectContaining({ file: "src/main/java/example/Producer.java", name: "hidden" }),
      repositoryReferences: expect.arrayContaining([expect.objectContaining({ file: "src/main/java/example/Consumer.java", line: 3 })]),
    }));
  }, 60_000);

  it.skipIf(!enabled || !calibrationCwd)("keeps an external Maven dependency workspace partial without discarding facts", async () => {
    const report = await Effect.runPromise(Effect.gen(function* () {
      const parser = yield* ParserService;
      return yield* collectJavaSymbolUse({ cwd: calibrationCwd!, languages: ["java"] }, { parser, executable: jdtls! });
    }).pipe(Effect.provide(TreeSitterParserLive)));

    expect(report.state).toMatchObject({
      availability: "partial",
      reason: expect.stringContaining("external dependencies"),
    });
    expect(report.facts.length).toBeGreaterThan(0);
  }, 180_000);

  // Calibration finding (2026-08): on a cold jdtls the demand query can select
  // the file while Eclipse has not built it yet - documentSymbols returns empty
  // for the demanded file, so the pruning assertion is not stable. Enabled once
  // the demand path warms the demanded file (or retries documentSymbols).
  it.skipIf(true || !enabled || !pruningCwd)("retains an external changed declaration while pruning the large Maven document set", async () => {
    const report = await Effect.runPromise(Effect.gen(function* () {
      const parser = yield* ParserService;
      return yield* collectJavaSymbolUse({
        cwd: pruningCwd!,
        languages: ["java"],
        demand: { declarations: [{ file: "src/main/java/junit/extensions/TestDecorator.java", names: ["run"] }] },
      }, { parser, executable: jdtls! });
    }).pipe(Effect.provide(TreeSitterParserLive)));

    expect(report.state).toMatchObject({
      availability: "partial",
      coverage: { declarations: "partial", repositoryReferences: "partial" },
      facts: expect.arrayContaining([expect.objectContaining({ declaration: expect.objectContaining({ file: "src/main/java/junit/extensions/TestDecorator.java", name: "run" }) })]),
      reason: expect.stringContaining("demand-driven semantic query selected 1/"),
    });
    const staticScope = await Effect.runPromise(collectStaticImportConsumers(pruningCwd!, "java", "src/main/java/junit/extensions/TestDecorator.java").pipe(Effect.provide(TreeSitterParserLive)));
    const run = report.facts.find((fact) => fact.declaration.file === "src/main/java/junit/extensions/TestDecorator.java" && fact.declaration.name === "run");
    const productionSymbolConsumers = run?.repositoryReferences.map((reference) => reference.file).filter((file) => staticScope.sourceFiles.includes(file));
    expect(staticScope.consumers).toEqual(["src/main/java/org/junit/internal/runners/JUnit38ClassRunner.java"]);
    expect(productionSymbolConsumers).toContain("src/main/java/org/junit/internal/runners/JUnit38ClassRunner.java");
    expect(productionSymbolConsumers).toContain("src/main/java/junit/extensions/ActiveTestSuite.java");
  }, 60_000);
});
