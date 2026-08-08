import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { SymbolUseServiceLive } from "../../src/adapter/symbol-use/SymbolUseServiceLive";
import { SemanticToolchainDiscoveryLive } from "../../src/adapter/toolchain/SemanticToolchainDiscoveryLive";
import { collectLspSymbolVersionPair } from "../../src/application/symbolVersionPair";

const roots: string[] = [];
const jdtls = process.env.OPENARCH_JDTLS_PATH;
const javac = process.env.OPENARCH_JAVAC_PATH;
const enabled = process.env.OPENARCH_JDTLS_INTEGRATION === "1" && Boolean(jdtls && javac);

const git = (cwd: string, args: readonly string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const project = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "openarch-symbol-version-jdtls-"));
  roots.push(cwd);
  mkdirSync(join(cwd, ".openarch"), { recursive: true });
  mkdirSync(join(cwd, "src", "main", "java", "example"), { recursive: true });
  writeFileSync(join(cwd, ".openarch", "config.yml"), "languages: [java]\n");
  writeFileSync(join(cwd, "pom.xml"), [
    '<project xmlns="http://maven.apache.org/POM/4.0.0">',
    "  <modelVersion>4.0.0</modelVersion>",
    "  <groupId>example</groupId><artifactId>version-pair</artifactId><version>1.0.0</version>",
    "  <properties><maven.compiler.release>21</maven.compiler.release></properties>",
    "</project>",
  ].join("\n") + "\n");
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "openarch@example.test"]);
  git(cwd, ["config", "user.name", "OpenArch test"]);
  return cwd;
};

const commit = (cwd: string, message: string): void => {
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", message]);
};

const collect = (cwd: string) => Effect.runPromise(
  collectLspSymbolVersionPair(cwd, "HEAD", "java").pipe(
    Effect.provide(SymbolUseServiceLive),
    Effect.provide(SemanticToolchainDiscoveryLive),
    Effect.provide(TreeSitterParserLive),
  ),
);

afterEach(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe("Java LSP version-paired symbol facts", () => {
  it.skipIf(!enabled)("collects JDT LS facts from isolated Git revision workspaces", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "src", "main", "java", "example", "Producer.java"), "package example;\n\nclass Producer { static String hidden() { return \"one\"; } }\n");
    writeFileSync(join(cwd, "src", "main", "java", "example", "Consumer.java"), "package example;\n\nclass Consumer { String use() { return Producer.hidden(); } }\n");
    commit(cwd, "before");
    writeFileSync(join(cwd, "src", "main", "java", "example", "Producer.java"), "package example;\n\nclass Producer { static String hidden() { return \"two\"; } }\n");
    commit(cwd, "after");

    const report = await collect(cwd);
    const matched = report.declarations.find((entry) => entry.status === "matched" && entry.after?.declaration.name === "hidden");

    expect(report).toMatchObject({
      language: "java", availability: "available",
      before: { providerId: "java-jdtls-symbol-use", availability: "available" },
      after: { providerId: "java-jdtls-symbol-use", availability: "available" },
    });
    expect(matched?.before?.repositoryReferences).toContainEqual(expect.objectContaining({ file: "src/main/java/example/Consumer.java", line: 3 }));
    expect(matched?.after?.repositoryReferences).toContainEqual(expect.objectContaining({ file: "src/main/java/example/Consumer.java", line: 3 }));
  }, 180_000);

  it.skipIf(!enabled)("preserves Java Maven dependency partial boundaries across revisions", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "pom.xml"), [
      '<project xmlns="http://maven.apache.org/POM/4.0.0">',
      "  <modelVersion>4.0.0</modelVersion>",
      "  <groupId>example</groupId><artifactId>version-pair</artifactId><version>1.0.0</version>",
      "  <properties><maven.compiler.release>21</maven.compiler.release></properties>",
      "  <dependencies></dependencies>",
      "</project>",
    ].join("\n") + "\n");
    writeFileSync(join(cwd, "src", "main", "java", "example", "Producer.java"), "package example;\n\nclass Producer { static String hidden() { return \"one\"; } }\n");
    writeFileSync(join(cwd, "src", "main", "java", "example", "Consumer.java"), "package example;\n\nclass Consumer { String use() { return Producer.hidden(); } }\n");
    commit(cwd, "before with dependency boundary");
    writeFileSync(join(cwd, "src", "main", "java", "example", "Producer.java"), "package example;\n\nclass Producer { static String hidden() { return \"two\"; } }\n");
    commit(cwd, "after with dependency boundary");

    const report = await collect(cwd);
    const matched = report.declarations.find((entry) => entry.status === "matched" && entry.after?.declaration.name === "hidden");

    expect(report).toMatchObject({
      language: "java", availability: "partial",
      before: { providerId: "java-jdtls-symbol-use", availability: "partial" },
      after: { providerId: "java-jdtls-symbol-use", availability: "partial" },
    });
    expect(report.before?.reason).toContain("external dependencies");
    expect(report.after?.reason).toContain("external dependencies");
    expect(matched?.before?.repositoryReferences).toContainEqual(expect.objectContaining({ file: "src/main/java/example/Consumer.java", line: 3 }));
    expect(matched?.after?.repositoryReferences).toContainEqual(expect.objectContaining({ file: "src/main/java/example/Consumer.java", line: 3 }));
  }, 180_000);
});
