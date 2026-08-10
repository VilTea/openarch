import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { defaultCommandDefinitions, findCommand, knownCommands } from "../../src/commands/index";
import { isHelpCommand, mainHelpText } from "../../src/commands/help";
import { analysisRecoveryHint, isAnalyzableSourceFile, parseOptionValues } from "../../src/runtime";
import { helpTextFor } from "../../src/commands/help";

const repositoryRoot = resolve(process.cwd(), "../..");

describe("CLI command registry", () => {
  it("collects only the values belonging to one repeated-value option", () => {
    expect(parseOptionValues(["--rule", "a.mjs", "b.mjs", "--changed", "src/a.ts"], "--rule")).toEqual(["a.mjs", "b.mjs"]);
    expect(parseOptionValues(["--changed"], "--rule")).toEqual([]);
  });

  it("uses the core scope contract instead of treating every matching extension as source", () => {
    expect(isAnalyzableSourceFile("packages/core/src/domain/ast.ts", repositoryRoot, "change-evidence")).toBe(true);
    expect(isAnalyzableSourceFile(".openarch/anti-patterns/rules/example.mjs", repositoryRoot, "change-evidence")).toBe(false);
  });

  it("offers history recovery guidance only for history IO failures", () => {
    expect(analysisRecoveryHint({ _tag: "IoError", path: "E:/project/.openarch/history/broken.json", cause: new Error("malformed history record") }, "zh"))
      .toContain("恢复指引");
    expect(analysisRecoveryHint({ _tag: "IoError", path: "E:/project/.openarch/baseline/_index.json", cause: new Error("malformed baseline") }, "zh"))
      .toBeUndefined();
    expect(analysisRecoveryHint({ _tag: "ParseError", path: "E:/project/.openarch/history/broken.json" }, "en"))
      .toBeUndefined();
  });

  it("registers every supported command", () => {
    expect(knownCommands).toEqual([
      "anti-patterns",
      "calibration",
      "check",
      "context",
      "coordination",
      "docs",
      "init",
      "lsp",
      "review",
      "rules",
      "scan",
      "toolchains",
      "update",
    ]);
  });

  it("routes help aliases through the help handler", () => {
    expect(isHelpCommand(undefined)).toBe(true);
    expect(isHelpCommand("--help")).toBe(true);
    expect(isHelpCommand("help")).toBe(true);
  });

  it("returns undefined for unknown commands", () => {
    expect(findCommand("missing-command")).toBeUndefined();
  });

  it("does not retain removed command aliases", () => {
    for (const command of ["diff", "gate", "test", "audit", "extensions", "discover", "record", "status", "evidence"]) {
      expect(findCommand(command)).toBeUndefined();
    }
  });

  it("keeps the public help surface aligned with the command registry boundary", () => {
    const help = mainHelpText("en");
    for (const command of defaultCommandDefinitions) expect(help).toContain(`  ${command.usage}`);
    for (const removed of ["diff", "gate", "guide", "test", "audit", "extensions", "discover", "record", "status", "evidence"]) {
      expect(help).not.toContain(`\n  ${removed} `);
    }
    expect(help).not.toContain("calibration"); // Advanced protocol entry is deliberately hidden.
  });

  it("makes optional coordination activation distinct from Git document storage", () => {
    const help = helpTextFor("en", "init");
    expect(help).toContain("--coordination-url <url>");
    expect(help).toContain("--docs-repo is Git document storage, not a coordination-service address");
  });

  it("exposes the full-analysis entry on check without a Git diff prerequisite", () => {
    const help = helpTextFor("en", "check");
    expect(help).toContain("--full");
    expect(help).toContain("--tests");
    expect(help).toContain("skip diff prerequisite; full analysis");
  });
});
