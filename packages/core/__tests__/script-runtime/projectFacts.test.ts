import { describe, expect, it } from "vitest";
import { createProjectFacts, isAuthorityProtectedRepositoryPath, selectScriptTargetFiles, unavailableRequiredFact } from "../../src/script-runtime/projectFacts";

describe("ProjectFacts", () => {
  it("exposes configured classifications without leaking config patterns or weights", () => {
    const facts = createProjectFacts({
      files: ["src/domain/value.ts", "src/spec/value.test.ts"],
      fileKindRules: [{ pattern: "src/spec/**", kind: "test" }],
      pathClasses: [
        { pattern: "src/domain/**", name: "domain", weight: 1.3 },
        { pattern: "**", name: "default" },
      ],
    });
    expect(facts.fileClassification).toMatchObject({
      availability: "available",
      value: [
        { repositoryPath: "src/domain/value.ts", fileKind: "production", pathClass: "domain" },
        { repositoryPath: "src/spec/value.test.ts", fileKind: "test", pathClass: "default" },
      ],
    });
    expect(JSON.stringify(facts.fileClassification.value)).not.toContain("1.3");
  });

  it("marks incomplete metric snapshots partial and rejects them for required facts", () => {
    const facts = createProjectFacts({
      files: ["src/a.ts", "src/b.ts"],
      baseline: {
        entries: new Map([["src/a.ts", {
          path: "src/a.ts", branchCount: 2, nestingDepth: 1, inDegree: 0, outDegree: 1, alphaStruct: 0.2,
        }]]),
        scopeMatches: true,
        metricContractMatches: true,
      },
    });
    expect(facts.structureMetrics.availability).toBe("partial");
    expect(facts.structureMetrics.value).toHaveLength(1);
    expect(unavailableRequiredFact(["structure-metrics.v1"], facts)).toContain("partial");
  });

  it("exposes provider-confirmed test spans only when the calling workflow supplies them", () => {
    const facts = createProjectFacts({
      files: ["src/value.test.ts"],
      testCaseSpans: {
        availability: "available",
        value: [{ file: "src/value.test.ts", providerId: "example", name: "cleans up", startLine: 3, endLine: 8, statuses: [] }],
      },
    });
    expect(facts.testCaseSpans.value).toEqual([expect.objectContaining({ name: "cleans up" })]);
    expect(unavailableRequiredFact(["test-case-spans.v1"], facts)).toBeUndefined();
    expect(unavailableRequiredFact(["test-case-spans.v1"], createProjectFacts({ files: ["src/value.test.ts"] }))).toContain("unavailable");
  });

  it("requires semantic relationship facts explicitly and preserves their availability boundary", () => {
    const available = createProjectFacts({
      files: ["src/value.ts"],
      semanticRelations: {
        availability: "available",
        value: { reports: [], relations: [] },
      },
    });
    expect(unavailableRequiredFact(["semantic-relations.v1"], available)).toBeUndefined();
    expect(unavailableRequiredFact(["semantic-relations.v1"], createProjectFacts({ files: ["src/value.ts"] }))).toContain("unavailable");
  });

  it("derives authority protected files with canonical path and directory semantics", () => {
    const facts = createProjectFacts({
      files: ["src\\owners\\first.ts", "src/owners/nested/second.ts", "src/owners-copy/third.ts", "src/exact.ts"],
      authorities: [
        { id: "owner-dir", owner: "src/owner.ts", protectedPaths: ["src/owners/"] },
        { id: "owner-file", owner: "src/owner.ts", protectedPaths: ["src/exact.ts"] },
      ],
    });
    const [directory, exact] = facts.authorities.value!;

    expect(directory.protectedFiles).toEqual(["src\\owners\\first.ts", "src/owners/nested/second.ts"]);
    expect(exact.protectedFiles).toEqual(["src/exact.ts"]);
    expect(isAuthorityProtectedRepositoryPath(directory, "src/owners-copy/third.ts")).toBe(false);
  });

  it("selects targets by classification, glob and declared authority without exposing raw matcher logic", () => {
    const facts = createProjectFacts({
      files: ["src/domain/value.ts", "src/domain/value.test.ts", "src/adapter/parser.ts"],
      fileKindRules: [{ pattern: "**/*.test.ts", kind: "test" }],
      pathClasses: [{ pattern: "src/domain/**", name: "domain" }, { pattern: "**", name: "default" }],
      authorities: [{ id: "domain-owner", owner: "src/domain/index.ts", protectedPaths: ["src/domain/"] }],
    });

    const selected = selectScriptTargetFiles(
      ["src/domain/value.ts", "src/domain/value.test.ts", "src/adapter/parser.ts"],
      { authority: ["domain-owner"], fileKinds: ["production"], include: ["src/**/*.ts"], exclude: ["**/*.test.ts"] },
      facts,
    );

    expect(selected).toEqual({ files: ["src/domain/value.ts"] });
  });

  it("selects a language target through the shared registry before scripts run", () => {
    const files = ["service/main.go", "src/app.ts", "scripts/tool.mjs"];
    const selected = selectScriptTargetFiles(files, { languages: ["go"], fileKinds: ["production"] }, createProjectFacts({ files }));

    expect(selected).toEqual({ files: ["service/main.go"] });
  });

  it("keeps change-surface facts available only when the calling change-set workflow supplies them", () => {
    const available = createProjectFacts({
      files: ["src/api.ts"],
      changeSurface: {
        availability: "available",
        value: { schemaVersion: 1, languages: ["typescript"], changedSymbols: [{ file: "src/api.ts", anchor: "Api.publish", kind: "public_method_sig", consumers: ["src/client.ts"] }] },
      },
    });
    expect(unavailableRequiredFact(["change-surface.v1"], available)).toBeUndefined();

    const without = createProjectFacts({ files: ["src/api.ts"] });
    expect(unavailableRequiredFact(["change-surface.v1"], without)).toContain("unavailable");
    expect(without.changeSurface.reason).toContain("check --semantic");
  });
});
