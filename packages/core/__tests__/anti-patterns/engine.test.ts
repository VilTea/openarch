import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { executeAntiPatternRule } from "../../src/anti-patterns/engine";
import { createProjectFacts } from "../../src/script-runtime/projectFacts";

const parser = { query: () => Effect.succeed([{ captures: [{ name: "name", text: "Duplicate" }] }]) } as never;
const facts = (authorities: readonly { id: string; owner: string }[] = []) => createProjectFacts({ files: [], authorities });

describe("executeAntiPatternRule", () => {
  it("rejects the retired named-rule export instead of preserving a compatibility path", async () => {
    const result = await executeAntiPatternRule("rules/legacy.mjs", [], parser, async () => ({
      rule: { scope: "change_set", detect: () => [] },
    }));
    expect(result.error).toContain("必须 export default");
  });

  it("rejects the retired file-level detect contract", async () => {
    const result = await executeAntiPatternRule("rules/legacy-file.mjs", [], parser, async () => ({
      default: { scope: "file", detect: () => [] },
    }));
    expect(result.error).toContain("file/repository 规则导出 { scope, stages, link }");
  });

  it("owns file traversal and injects source/scope", async () => {
    const result = await executeAntiPatternRule("rules/no-empty-catch.mjs", ["a.ts"], parser, async () => ({
      default: {
        scope: "file",
        stages: { ast: { pattern: "(catch_clause) @catch" } },
        link: ({ records }: { records: Array<{ _file: string }> }) => [{ ruleId: "no-empty-catch", file: records[0]._file, message: "empty catch" }],
      },
    }));
    expect(result.hits).toEqual([expect.objectContaining({ source: "no-empty-catch.mjs", scope: "file" })]);
  });

  it("preserves report-only explanation metadata without turning it into policy", async () => {
    const result = await executeAntiPatternRule("rules/metadata.mjs", ["a.ts"], parser, async () => ({
      default: {
        scope: "file",
        stages: {},
        link: () => [{
          ruleId: "placeholder",
          file: "a.ts",
          message: "placeholder implementation",
          category: "quality",
          severity: "warning",
          patternFamily: "placeholder-implementation",
          suggestion: "replace the stub with the required behavior",
        }],
      },
    }));

    expect(result.hits).toEqual([expect.objectContaining({
      category: "quality",
      severity: "warning",
      patternFamily: "placeholder-implementation",
      suggestion: "replace the stub with the required behavior",
    })]);
  });

  it("rejects unsupported explanation metadata instead of silently dropping it", async () => {
    const result = await executeAntiPatternRule("rules/invalid-metadata.mjs", ["a.ts"], parser, async () => ({
      default: {
        scope: "file",
        stages: {},
        link: () => [{ ruleId: "bad", file: "a.ts", message: "bad", severity: "critical" }],
      },
    }));

    expect(result.error).toContain("命中必须包含 ruleId/file/message 字符串字段");
  });

  it("collects repository query records before relation logic runs", async () => {
    const result = await executeAntiPatternRule("rules/duplicate.mjs", ["a.ts", "b.ts"], parser, async () => ({
      default: {
        scope: "repository",
        stages: { text: ({ files }: { files: readonly string[] }) => files.slice(0, 1), ast: { pattern: "(identifier) @name", extract: (matches: Array<{ captures: Array<{ text: string }> }>) => matches.map(match => ({ name: match.captures[0].text })) } },
        link: ({ records }: { records: Array<{ _file: string; name: string }> }) => [{ ruleId: "duplicate", file: records[0]._file, message: `${records.length} declarations` }],
      },
    }));
    expect(result.hits).toEqual([expect.objectContaining({ scope: "repository", message: "1 declarations" })]);
    expect(result.stages).toMatchObject({ inputFiles: 2, candidateFiles: ["a.ts"] });
  });

  it("applies declarative authority targets before the text stage", async () => {
    const authorityFacts = createProjectFacts({
      files: ["src/owned.ts", "src/other.ts"],
      authorities: [{ id: "owner", owner: "src/owner.ts", protectedPaths: ["src/owned.ts"] }],
    });
    const result = await executeAntiPatternRule("rules/target.mjs", ["src/owned.ts", "src/other.ts"], parser, async () => ({
      default: {
        scope: "file",
        targets: { authority: ["owner"] },
        stages: { text: ({ files }: { files: readonly string[] }) => [...files] },
        link: ({ records }: { records: Array<{ _file: string }> }) => records.map((record) => ({ ruleId: "target", file: record._file, message: "selected" })),
      },
    }), { facts: authorityFacts });

    expect(result.stages).toMatchObject({ inputFiles: 2, targetFiles: ["src/owned.ts"], candidateFiles: ["src/owned.ts"] });
    expect(result.hits).toEqual([expect.objectContaining({ file: "src/owned.ts" })]);
  });

  it("derives a rule-local authority without adding it to project configuration", async () => {
    const result = await executeAntiPatternRule("rules/local-authority.mjs", ["src/owned.ts", "src/other.ts"], parser, async () => ({
      default: {
        scope: "repository",
        authority: { id: "local-owner", owner: "src/owner.ts", protectedPaths: ["src/owned.ts"] },
        targets: { authority: ["local-owner"] },
        stages: { text: ({ files }: { files: readonly string[] }) => [...files] },
        link: ({ records, facts: projectFacts }: { records: Array<{ _file: string }>; facts: { authorities: { value?: Array<{ id: string }> } } }) => records.map((record) => ({
          ruleId: "local-authority", file: record._file,
          message: projectFacts.authorities.value?.map((authority) => authority.id).join(",") ?? "missing",
        })),
      },
    }), { facts: createProjectFacts({ files: ["src/owned.ts", "src/other.ts"] }) });

    expect(result.stages).toMatchObject({ targetFiles: ["src/owned.ts"] });
    expect(result.hits).toEqual([expect.objectContaining({ file: "src/owned.ts", message: "local-owner" })]);
  });

  it("rejects a rule-local authority that collides with a reusable project authority", async () => {
    const result = await executeAntiPatternRule("rules/colliding-authority.mjs", ["src/owned.ts"], parser, async () => ({
      default: {
        scope: "file",
        authority: { id: "owner", owner: "src/local.ts", protectedPaths: ["src/owned.ts"] },
        stages: {}, link: () => [],
      },
    }), {
      facts: createProjectFacts({ files: ["src/owned.ts"], authorities: [{ id: "owner", owner: "src/global.ts" }] }),
    });

    expect(result.error).toContain("collides with project authority: owner");
  });

  it("rejects script attempts to supply engine-derived protected files", async () => {
    const result = await executeAntiPatternRule("rules/forged-authority.mjs", ["src/owned.ts"], parser, async () => ({
      default: {
        scope: "file",
        authority: {
          id: "local-owner", owner: "src/owner.ts", protectedPaths: ["src/owned.ts"], protectedFiles: ["src/owned.ts"],
        },
        stages: {}, link: () => [],
      },
    }), { facts: createProjectFacts({ files: ["src/owned.ts"] }) });

    expect(result.error).toContain("必须 export default");
  });

  it("passes explicit authority contracts through the shared project facts", async () => {
    const result = await executeAntiPatternRule("rules/authority.mjs", ["a.ts"], parser, async () => ({
      default: {
        scope: "repository", stages: {},
        requires: ["authorities.v1"],
        link: ({ facts: projectFacts }: { facts: { authorities: { value?: Array<{ id: string }> } } }) => [{ ruleId: "authority", file: "a.ts", message: projectFacts.authorities.value?.[0]?.id ?? "missing" }],
      },
    }), { facts: facts([{ id: "script-runtime", owner: "src/staged.ts" }]) });
    expect(result.hits).toEqual([expect.objectContaining({ ruleId: "authority", message: "script-runtime" })]);
  });

  it("does not run a rule that requires unavailable structure facts", async () => {
    const result = await executeAntiPatternRule("rules/metrics.mjs", ["a.ts"], parser, async () => ({
      default: {
        scope: "file", requires: ["structure-metrics.v1"], stages: {},
        link: () => { throw new Error("must not execute"); },
      },
    }), { facts: facts() });
    expect(result.unavailable).toContain("structure-metrics.v1");
    expect(result.hits).toEqual([]);
  });

  it("reports unavailable when the engine cannot parse a static-import candidate", async () => {
    const failingParser = {
      parse: () => Effect.fail(new Error("grammar unavailable")),
      query: () => Effect.succeed([]),
    } as never;
    const result = await executeAntiPatternRule("rules/static-imports.mjs", ["a.go"], failingParser, async () => ({
      default: {
        scope: "repository",
        stages: { ast: { fact: "static-imports.v1" } },
        link: () => { throw new Error("must not execute"); },
      },
    }), { facts: createProjectFacts({ files: ["a.go"] }) });

    expect(result.hits).toEqual([]);
    expect(result.unavailable).toContain("static-imports.v1 unavailable for a.go");
  });

  it("reports unavailable when an ordinary AST query cannot parse a candidate", async () => {
    const failingParser = { query: () => Effect.fail(new Error("grammar unavailable")) } as never;
    const result = await executeAntiPatternRule("rules/ast.mjs", ["a.java"], failingParser, async () => ({
      default: {
        scope: "file",
        stages: { ast: { pattern: "(method_declaration) @method" } },
        link: () => { throw new Error("must not execute"); },
      },
    }));

    expect(result.hits).toEqual([]);
    expect(result.unavailable).toContain("AST query unavailable for a.java: grammar unavailable");
  });

  it("reports change-set rules as unavailable without Git context", async () => {
    const result = await executeAntiPatternRule("rules/change.mjs", [], parser, async () => ({ default: { scope: "change_set", detect: () => [] } }));
    expect(result.unavailable).toContain("change-set Git context");
  });

  it("injects bounded change facts and shared authority facts into change-set rules", async () => {
    const result = await executeAntiPatternRule("rules/change.mjs", [], parser, async () => ({
      default: {
        scope: "change_set",
        requires: ["authorities.v1"],
        detect: ({ changeSet, facts: projectFacts }: { changeSet: { files: Array<{ path: string }> }; facts: { authorities: { value?: Array<{ id: string }> } } }) => [{
          ruleId: "authority-bypass",
          file: changeSet.files[0].path,
          message: `bypasses ${projectFacts.authorities.value?.[0]?.id}`,
        }],
      },
    }), {
      changeSet: { availability: "available", files: [{ path: "src/parser.ts", kind: "modified", beforeText: "old", afterText: "new" }] },
      facts: facts([{ id: "module-resolution", owner: "src/module-resolver.ts" }]),
    });
    expect(result.hits).toEqual([expect.objectContaining({
      scope: "change_set", ruleId: "authority-bypass", message: "bypasses module-resolution",
    })]);
  });

  it("adds rule-local authority ids to bounded change facts", async () => {
    const result = await executeAntiPatternRule("rules/local-change.mjs", [], parser, async () => ({
      default: {
        scope: "change_set",
        authority: { id: "local-boundary", owner: "src/owner.ts", protectedPaths: ["src/owned.ts"] },
        detect: ({ changeSet }: { changeSet: { files: Array<{ authorityIds?: readonly string[] }> } }) => [{
          ruleId: "local-boundary", file: "src/owned.ts", message: changeSet.files[0].authorityIds?.join(",") ?? "missing",
        }],
      },
    }), {
      changeSet: { availability: "available", files: [{ path: "src/owned.ts", kind: "modified", beforeText: "old", afterText: "new" }] },
      facts: createProjectFacts({ files: ["src/owned.ts"] }),
    });

    expect(result.hits).toEqual([expect.objectContaining({ message: "local-boundary" })]);
  });
});
