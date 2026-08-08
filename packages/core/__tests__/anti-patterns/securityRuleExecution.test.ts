import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { executeAntiPatternRule } from "../../src/anti-patterns/engine";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { ParserService } from "../../src/port/ParserService";
import { createProjectFacts, normalizeRepositoryPath } from "../../src/script-runtime/projectFacts";

const rulePath = () => join(process.cwd(), "..", "..", ".openarch", "anti-patterns", "rules", "no-interpolated-shell-command.mjs");

const parser = () => Effect.runPromise(Effect.gen(function* () {
  return yield* ParserService;
}).pipe(Effect.provide(TreeSitterParserLive)));

describe("project shell-command security rule", () => {
  it("uses parser-confirmed call syntax for unsafe and legal execution fixtures", async () => {
    const directory = join(tmpdir(), `openarch-security-rule-${Date.now()}`);
    const packageDir = join(directory, "packages");
    const unsafe = join(packageDir, "unsafe.ts");
    const safe = join(packageDir, "safe.ts");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(unsafe, 'execSync(`git clone "${url}" "${target}"`);');
    writeFileSync(safe, 'execFileSync("git", ["clone", "--", url, target]);');
    const service = await parser();

    try {
      const facts = createProjectFacts({ files: [unsafe, safe], projectRoot: directory });
      const result = await executeAntiPatternRule(rulePath(), [unsafe, safe], service, undefined, { facts });
      expect(result.hits).toEqual([expect.objectContaining({ ruleId: "no-interpolated-shell-command", file: normalizeRepositoryPath(unsafe) })]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
