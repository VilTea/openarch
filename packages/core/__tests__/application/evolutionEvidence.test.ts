import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ParserService } from "../../src/port/ParserService";
import { enrichCochangeSets, enrichCoordinationCandidates, pruneUncorroboratedCochangeSets } from "../../src/application/evolutionEvidence";
import { withGitRepo } from "../support/tsProject";

const parserFor = (cwd: string): ParserService => ({
  parse: () => Effect.die("not used"),
  parseText: (path, text) => Effect.succeed({
    path,
    language: "typescript" as const,
    branchCount: 0,
    nestingDepth: 0,
    functionCount: 0,
    passthroughCalls: 0,
    imports: text.includes('from "./member"')
      ? [{ source: "./member", resolvedPath: resolve(cwd, "src/member.ts") }]
      : [],
    loc: 1,
    functions: [],
    semanticSurface: {
      declarations: [{
        id: "value", kind: "function", isPublic: true, signature: "export function value()", body: text,
      }],
      unsupportedTopLevel: [],
    },
  }),
  query: () => Effect.succeed([]),
  supportedLanguages: Effect.succeed(["typescript"]),
});

describe("enrichCoordinationCandidates", () => {
  it("confirms a historical import introduced with a new direct member", async () => {
    await withGitRepo([
      { path: "src/catalog.ts", content: "export const catalog = [];\n" },
    ], async (cwd) => {
      writeFileSync(join(cwd, "src", "member.ts"), "export const member = true;\n");
      writeFileSync(join(cwd, "src", "catalog.ts"), 'import { member } from "./member";\nexport const catalog = [member];\n');
      const git = (args: readonly string[]): void => execFileSync("git", args, { cwd, stdio: "pipe" });
      git(["add", "."]);
      git(["commit", "-m", "register member"]);
      const commitId = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();

      const result = await enrichCoordinationCandidates(cwd, [{
        coordinator: "src/catalog.ts",
        members: ["src/member.ts"],
        events: [{ member: "src/member.ts", commitId }],
        coordinatorLoc: 10,
        averageMemberLoc: 10,
        directImportCount: 1,
        commitCount: 1,
        occurrences: 1,
        historyEntries: [commitId],
        maxInDegree: 0,
        maxAlphaStruct: 0,
      }], parserFor(cwd));

      expect(result.candidates[0]?.historicalEvidence).toEqual({
        status: "confirmed", inspectedEvents: 1, confirmedEvents: 1, unavailableEvents: 0,
      });
      expect(result.trace).toMatchObject({ candidatesSelected: 1, eventsSelected: 1, confirmedEvents: 1 });
    });
  });

  it("reports unavailable when historical source cannot be read", async () => {
    const candidate = {
      coordinator: "src/catalog.ts",
      members: ["src/member.ts"],
      events: [{ member: "src/member.ts", commitId: "missing-revision" }],
      coordinatorLoc: 10,
      averageMemberLoc: 10,
      directImportCount: 1,
      commitCount: 1,
      occurrences: 1,
      historyEntries: ["missing-revision"],
      maxInDegree: 0,
      maxAlphaStruct: 0,
    };
    const result = await enrichCoordinationCandidates(process.cwd(), [candidate], parserFor(process.cwd()));

    expect(result.candidates[0]?.historicalEvidence).toEqual({
      status: "unavailable", inspectedEvents: 1, confirmedEvents: 0, unavailableEvents: 1,
    });
  });

  it("shares the coordination event budget before sampling a second event from any surface", async () => {
    const candidates = Array.from({ length: 6 }, (_, index) => ({
      coordinator: `src/catalog-${index}.ts`,
      members: [`src/member-${index}.ts`],
      events: Array.from({ length: 3 }, (_, event) => ({ member: `src/member-${index}-${event}.ts`, commitId: `missing-${index}-${event}` })),
      coordinatorLoc: 10,
      averageMemberLoc: 10,
      directImportCount: 1,
      commitCount: 3,
      occurrences: 3,
      historyEntries: [`missing-${index}-0`],
      maxInDegree: 0,
      maxAlphaStruct: 0,
    }));
    const result = await enrichCoordinationCandidates(process.cwd(), candidates, parserFor(process.cwd()));

    expect(result.trace).toMatchObject({ candidatesSelected: 6, candidatesDeferred: 0, eventsSelected: 12, unavailableEvents: 12 });
    expect(result.candidates.map((candidate) => candidate.historicalEvidence?.inspectedEvents)).toEqual([2, 2, 2, 2, 2, 2]);
  });

  it("confirms aligned semantic changes for selected co-change members without reading unrelated deleted files", async () => {
    await withGitRepo([
      { path: "src/a.ts", content: "export function value() { return 0; }\n" },
      { path: "src/b.ts", content: "export function value() { return 0; }\n" },
      { path: "src/c.ts", content: "export function value() { return 0; }\n" },
      { path: "src/retired.ts", content: "export const retired = true;\n" },
    ], async (cwd) => {
      const git = (args: readonly string[]): void => execFileSync("git", args, { cwd, stdio: "pipe" });
      const commits: string[] = [];
      for (const revision of [1, 2, 3]) {
        for (const name of ["a", "b", "c"]) writeFileSync(join(cwd, "src", `${name}.ts`), `export function value() { return ${revision}; }\n`);
        if (revision === 1) rmSync(join(cwd, "src", "retired.ts"));
        git(["add", "-A"]);
        git(["commit", "-m", `revision ${revision}`]);
        commits.push(execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim());
      }

      const result = await enrichCochangeSets(cwd, [{
        files: ["src/a.ts", "src/b.ts", "src/c.ts"],
        occurrences: 3,
        minimumMemberCoverage: 1,
        averageBatchSize: 3,
        currentInternalImportCount: 0,
        currentImportComponents: 3,
        actionSummary: { added: 0, modified: 9, deleted: 0, observedCommits: 3 },
        historyEntries: commits,
        supportingCommits: commits,
        maxInDegree: 0,
        maxAlphaStruct: 0,
      }], parserFor(cwd));

      expect(result.candidates[0]?.historicalEvidence).toEqual({
        status: "aligned",
        inspectedCommits: 3,
        alignedCommits: 3,
        unavailableCommits: 0,
        dominantChangeKinds: ["function_body"],
      });
      expect(result.trace).toMatchObject({ candidatesSelected: 1, commitsSelected: 3, alignedCommits: 3, unavailableCommits: 0 });
    });
  });

  it("prunes only a semantically mixed, currently isolated co-change set", () => {
    const candidate = {
      files: ["src/a.ts", "src/b.ts", "src/c.ts"],
      occurrences: 3,
      minimumMemberCoverage: 1,
      averageBatchSize: 3,
      currentInternalImportCount: 0,
      currentImportComponents: 3,
      actionSummary: { added: 0, modified: 9, deleted: 0, observedCommits: 3 },
      historyEntries: ["one", "two", "three"],
      supportingCommits: ["one", "two", "three"],
      maxInDegree: 0,
      maxAlphaStruct: 0,
    };
    const result = pruneUncorroboratedCochangeSets([
      { ...candidate, historicalEvidence: { status: "mixed" as const, inspectedCommits: 3, alignedCommits: 1, unavailableCommits: 0, dominantChangeKinds: ["function_body" as const] } },
      { ...candidate, historicalEvidence: { status: "partial" as const, inspectedCommits: 3, alignedCommits: 1, unavailableCommits: 1, dominantChangeKinds: ["function_body" as const] } },
      { ...candidate, currentImportComponents: 2, historicalEvidence: { status: "mixed" as const, inspectedCommits: 3, alignedCommits: 1, unavailableCommits: 0, dominantChangeKinds: ["function_body" as const] } },
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((entry) => entry.historicalEvidence?.status)).toEqual(["partial", "mixed"]);
  });
});
