import { describe, expect, it } from "vitest";
import { analyzeEvolutionSignals } from "../../src/domain/evolutionSignals";

describe("analyzeEvolutionSignals", () => {
  it("reports a closed repeated production co-change set with bounded history evidence", () => {
    const report = analyzeEvolutionSignals([
      { id: "first", files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/first-only.ts"], changes: ["a", "b", "c"].map((name) => ({ path: `src/${name}.ts`, kind: "modified" as const })) },
      { id: "second", files: ["src/a.ts", "src/b.ts", "src/c.ts"], changes: ["a", "b", "c"].map((name) => ({ path: `src/${name}.ts`, kind: "modified" as const })) },
      { id: "third", files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/third-only.ts"], changes: ["a", "b", "c"].map((name) => ({ path: `src/${name}.ts`, kind: "modified" as const })) },
    ], [
      { path: "src/a.ts", inDegree: 1, alphaStruct: 0.2, imports: ["src/b.ts"] },
      { path: "src/b.ts", inDegree: 7, alphaStruct: 0.8, imports: ["src/c.ts"] },
      { path: "src/c.ts", inDegree: 0, alphaStruct: 0 },
      { path: "src/first-only.ts", inDegree: 0, alphaStruct: 0 },
      { path: "src/third-only.ts", inDegree: 0, alphaStruct: 0 },
    ]);

    expect(report.cochangeSets).toEqual({
      availability: "available",
      candidates: [expect.objectContaining({
        files: ["src/a.ts", "src/b.ts", "src/c.ts"],
        occurrences: 3,
        minimumMemberCoverage: 1,
        averageBatchSize: 11 / 3,
        currentInternalImportCount: 2,
        currentImportComponents: 1,
        actionSummary: { added: 0, modified: 9, deleted: 0, observedCommits: 3 },
        historyEntries: ["first", "second", "third"],
        supportingCommits: ["first", "second", "third"],
        maxInDegree: 7,
        maxAlphaStruct: 0.8,
      })],
    });
  });

  it("excludes historical paths without current baseline facts instead of assuming production", () => {
    const report = analyzeEvolutionSignals([
      { id: "first", files: ["src/a.ts", "src/b.ts", "src/retired.ts"] },
      { id: "second", files: ["src/a.ts", "src/b.ts", "src/retired.ts"] },
      { id: "third", files: ["src/a.ts", "src/b.ts", "src/retired.ts"] },
    ], [
      { path: "src/a.ts", inDegree: 0, alphaStruct: 0 },
      { path: "src/b.ts", inDegree: 0, alphaStruct: 0 },
    ]);

    expect(report.eligibleChangeSets).toBe(3);
    expect(report.unavailableHistoryFiles).toBe(1);
    expect(report.cochangeSets).toEqual({ availability: "available", candidates: [] });
  });

  it("silently prunes a co-change set dominated by a tighter candidate", () => {
    const report = analyzeEvolutionSignals([
      { id: "dense-one", files: ["src/a.ts", "src/b.ts", "src/c.ts"] },
      { id: "dense-two", files: ["src/a.ts", "src/b.ts", "src/c.ts"] },
      { id: "dense-three", files: ["src/a.ts", "src/b.ts", "src/c.ts"] },
      { id: "hub-one", files: ["src/x.ts", "src/y.ts", "src/z.ts"] },
      { id: "hub-two", files: ["src/x.ts", "src/y.ts", "src/z.ts"] },
      { id: "hub-three", files: ["src/x.ts", "src/y.ts", "src/z.ts"] },
      { id: "hub-four", files: ["src/x.ts", "src/y.ts", "src/z.ts"] },
      { id: "x-extra-one", files: ["src/x.ts", "src/extra-one.ts"] },
      { id: "x-extra-two", files: ["src/x.ts", "src/extra-two.ts"] },
    ], [
      ...["a", "b", "c", "x", "y", "z"].map((name) => ({ path: `src/${name}.ts`, inDegree: 0, alphaStruct: 0 })),
      { path: "src/extra-one.ts", inDegree: 0, alphaStruct: 0 },
      { path: "src/extra-two.ts", inDegree: 0, alphaStruct: 0 },
    ]);

    expect(report.cochangeSets.availability).toBe("available");
    expect(report.cochangeSets.candidates).toEqual([expect.objectContaining({
      files: ["src/a.ts", "src/b.ts", "src/c.ts"],
      occurrences: 3,
      minimumMemberCoverage: 1,
    })]);
  });

  it("does not turn a single co-change or test-only history into a set candidate", () => {
    const report = analyzeEvolutionSignals([
      { id: "one", files: ["src/a.ts", "src/b.ts"] },
      { id: "tests", files: ["src/a.test.ts", "src/b.test.ts"] },
    ], [
      { path: "src/a.ts", inDegree: 0, alphaStruct: 0, imports: ["src/b.ts"] },
      { path: "src/b.ts", inDegree: 0, alphaStruct: 0 },
      { path: "src/a.test.ts", fileKind: "test", inDegree: 0, alphaStruct: 0 },
      { path: "src/b.test.ts", fileKind: "test", inDegree: 0, alphaStruct: 0 },
    ]);
    expect(report).toMatchObject({ eligibleChangeSets: 1, unavailableHistoryFiles: 0, coordinationCandidates: [] });
    expect(report.cochangeSets).toEqual({ availability: "available", candidates: [] });
  });

  it("elevates a coordinator when separate commits add distinct direct members through it", () => {
    const report = analyzeEvolutionSignals([
      {
        id: "one", files: ["src/catalog.ts", "src/a.ts"],
        changes: [{ path: "src/catalog.ts", kind: "modified" }, { path: "src/a.ts", kind: "added" }],
      },
      {
        id: "two", files: ["src/catalog.ts", "src/b.ts"],
        changes: [{ path: "src/catalog.ts", kind: "modified" }, { path: "src/b.ts", kind: "added" }],
      },
    ], [
      { path: "src/catalog.ts", loc: 20, inDegree: 5, alphaStruct: 0.7, imports: ["src/a.ts", "src/b.ts", "src/unrelated.ts"] },
      { path: "src/a.ts", loc: 60, inDegree: 1, alphaStruct: 0.2 },
      { path: "src/b.ts", loc: 80, inDegree: 2, alphaStruct: 0.3 },
      { path: "src/unrelated.ts", inDegree: 0, alphaStruct: 0 },
    ]);

    expect(report.coordinationCandidates).toEqual([expect.objectContaining({
      coordinator: "src/catalog.ts",
      members: ["src/a.ts", "src/b.ts"],
      events: [
        { member: "src/a.ts", commitId: "one" },
        { member: "src/b.ts", commitId: "two" },
      ],
      coordinatorLoc: 20,
      averageMemberLoc: 70,
      directImportCount: 3,
      commitCount: 2,
      occurrences: 2,
      maxInDegree: 5,
      maxAlphaStruct: 0.7,
    })]);
    expect(report.extensionSurfaces).toEqual({ availability: "available", candidates: [] });
  });

  it("does not treat parser-confirmed public re-exports as coordinator imports", () => {
    const report = analyzeEvolutionSignals([
      {
        id: "one", files: ["src/barrel.ts", "src/a.ts"],
        changes: [{ path: "src/barrel.ts", kind: "modified" }, { path: "src/a.ts", kind: "added" }],
      },
      {
        id: "two", files: ["src/barrel.ts", "src/b.ts"],
        changes: [{ path: "src/barrel.ts", kind: "modified" }, { path: "src/b.ts", kind: "added" }],
      },
    ], [
      { path: "src/barrel.ts", loc: 20, inDegree: 5, alphaStruct: 0.7, imports: ["src/a.ts", "src/b.ts"], reexports: ["src/a.ts", "src/b.ts"] },
      { path: "src/a.ts", loc: 60, inDegree: 1, alphaStruct: 0.2 },
      { path: "src/b.ts", loc: 80, inDegree: 2, alphaStruct: 0.3 },
    ]);

    expect(report.coordinationCandidates).toEqual([]);
    expect(report.extensionSurfaces).toEqual({ availability: "available", candidates: [] });
  });

  it("keeps the coordinator eligible when extensions are smaller than the integration surface", () => {
    const report = analyzeEvolutionSignals([
      {
        id: "one", files: ["src/catalog.ts", "src/a.ts"],
        changes: [{ path: "src/catalog.ts", kind: "modified" }, { path: "src/a.ts", kind: "added" }],
      },
      {
        id: "two", files: ["src/catalog.ts", "src/b.ts"],
        changes: [{ path: "src/catalog.ts", kind: "modified" }, { path: "src/b.ts", kind: "added" }],
      },
    ], [
      { path: "src/catalog.ts", loc: 80, inDegree: 5, alphaStruct: 0.7, imports: ["src/a.ts", "src/b.ts"] },
      { path: "src/a.ts", loc: 10, inDegree: 1, alphaStruct: 0.2 },
      { path: "src/b.ts", loc: 12, inDegree: 2, alphaStruct: 0.3 },
    ]);

    expect(report.coordinationCandidates).toHaveLength(1);
    expect(report.extensionSurfaces).toEqual({ availability: "available", candidates: [] });
  });

  it("finds a repeated existing extension surface without weakening global co-change", () => {
    const extensions = ["a", "b"].map((member) => ({
      id: `add-${member}`,
      files: ["src/factory.ts", "src/languageSupport.ts", "src/catalog.ts", `src/${member}.ts`],
      changes: [
        { path: "src/factory.ts", kind: "modified" as const },
        { path: "src/languageSupport.ts", kind: "modified" as const },
        { path: "src/catalog.ts", kind: "modified" as const },
        { path: `src/${member}.ts`, kind: "added" as const },
      ],
    }));
    const report = analyzeEvolutionSignals(extensions, [
      { path: "src/factory.ts", loc: 40, inDegree: 4, alphaStruct: 0.7, imports: ["src/a.ts", "src/b.ts", "src/languageSupport.ts"] },
      { path: "src/languageSupport.ts", loc: 20, inDegree: 2, alphaStruct: 0.3 },
      { path: "src/catalog.ts", loc: 20, inDegree: 1, alphaStruct: 0.2 },
      ...["a", "b"].map((member) => ({ path: `src/${member}.ts`, loc: 30, inDegree: 0, alphaStruct: 0 })),
    ]);

    expect(report.cochangeSets).toEqual({ availability: "available", candidates: [] });
    expect(report.extensionSurfaces).toEqual({
      availability: "available",
      candidates: expect.arrayContaining([
        expect.objectContaining({
          coordinator: "src/factory.ts",
          files: ["src/catalog.ts", "src/factory.ts", "src/languageSupport.ts"],
          occurrences: 2,
          extensionMembers: ["src/a.ts", "src/b.ts"],
        }),
      ]),
    });
  });

  it("projects public-forwarding-only files out of an extension surface", () => {
    const extensions = ["a", "b"].map((member) => ({
      id: `add-${member}`,
      files: ["src/factory.ts", "src/barrel.ts", "src/catalog.ts", `src/${member}.ts`],
      changes: [
        { path: "src/factory.ts", kind: "modified" as const },
        { path: "src/barrel.ts", kind: "modified" as const },
        { path: "src/catalog.ts", kind: "modified" as const },
        { path: `src/${member}.ts`, kind: "added" as const },
      ],
    }));
    const report = analyzeEvolutionSignals(extensions, [
      { path: "src/factory.ts", loc: 40, inDegree: 4, alphaStruct: 0.7, imports: ["src/a.ts", "src/b.ts"] },
      { path: "src/barrel.ts", loc: 20, inDegree: 2, alphaStruct: 0.3, imports: ["src/a.ts", "src/b.ts"], reexports: ["src/a.ts", "src/b.ts"] },
      { path: "src/catalog.ts", loc: 20, inDegree: 1, alphaStruct: 0.2 },
      ...["a", "b"].map((member) => ({ path: `src/${member}.ts`, loc: 30, inDegree: 0, alphaStruct: 0 })),
    ]);

    expect(report.extensionSurfaces.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ coordinator: "src/factory.ts", files: ["src/catalog.ts", "src/factory.ts"] }),
    ]));
    expect(report.extensionSurfaces.candidates.flatMap((candidate) => candidate.files)).not.toContain("src/barrel.ts");
  });

  it("does not call one repeated file or one extension a multi-write surface", () => {
    const report = analyzeEvolutionSignals([
      {
        id: "one", files: ["src/factory.ts", "src/a.ts"],
        changes: [{ path: "src/factory.ts", kind: "modified" }, { path: "src/a.ts", kind: "added" }],
      },
      {
        id: "two", files: ["src/factory.ts", "src/catalog.ts", "src/b.ts"],
        changes: [
          { path: "src/factory.ts", kind: "modified" },
          { path: "src/catalog.ts", kind: "modified" },
          { path: "src/b.ts", kind: "added" },
        ],
      },
    ], [
      { path: "src/factory.ts", loc: 40, inDegree: 4, alphaStruct: 0.7, imports: ["src/a.ts", "src/b.ts"] },
      { path: "src/catalog.ts", loc: 20, inDegree: 1, alphaStruct: 0.2 },
      { path: "src/a.ts", loc: 30, inDegree: 0, alphaStruct: 0 },
      { path: "src/b.ts", loc: 30, inDegree: 0, alphaStruct: 0 },
    ]);

    expect(report.coordinationCandidates).toHaveLength(1);
    expect(report.extensionSurfaces).toEqual({ availability: "available", candidates: [] });
  });

  it("does not confuse bootstrap or maintenance work with a repeated closed set", () => {
    const report = analyzeEvolutionSignals([
      {
        id: "bootstrap", files: ["src/catalog.ts", "src/a.ts", "src/b.ts"],
        changes: [
          { path: "src/catalog.ts", kind: "added" },
          { path: "src/a.ts", kind: "added" },
          { path: "src/b.ts", kind: "added" },
        ],
      },
      {
        id: "single-extension", files: ["src/catalog.ts", "src/a.ts", "src/b.ts"],
        changes: [
          { path: "src/catalog.ts", kind: "modified" },
          { path: "src/a.ts", kind: "added" },
          { path: "src/b.ts", kind: "added" },
        ],
      },
    ], [
      { path: "src/catalog.ts", loc: 20, inDegree: 5, alphaStruct: 0.7, imports: ["src/a.ts", "src/b.ts"] },
      { path: "src/a.ts", loc: 60, inDegree: 1, alphaStruct: 0.2 },
      { path: "src/b.ts", loc: 80, inDegree: 2, alphaStruct: 0.3 },
    ]);

    expect(report.coordinationCandidates).toEqual([]);
    expect(report.cochangeSets).toEqual({ availability: "available", candidates: [] });
  });

  it("does not let a pure-add bootstrap commit satisfy repeated co-change support", () => {
    const report = analyzeEvolutionSignals([
      {
        id: "bootstrap", files: ["src/a.ts", "src/b.ts", "src/c.ts"],
        changes: ["a", "b", "c"].map((name) => ({ path: `src/${name}.ts`, kind: "added" as const })),
      },
      {
        id: "revision-one", files: ["src/a.ts", "src/b.ts", "src/c.ts"],
        changes: ["a", "b", "c"].map((name) => ({ path: `src/${name}.ts`, kind: "modified" as const })),
      },
      {
        id: "revision-two", files: ["src/a.ts", "src/b.ts", "src/c.ts"],
        changes: ["a", "b", "c"].map((name) => ({ path: `src/${name}.ts`, kind: "modified" as const })),
      },
    ], [
      ...["a", "b", "c"].map((name) => ({ path: `src/${name}.ts`, inDegree: 0, alphaStruct: 0 })),
    ]);

    expect(report.eligibleChangeSets).toBe(2);
    expect(report.bootstrapChangeSetsExcluded).toBe(1);
    expect(report.cochangeSets).toEqual({ availability: "available", candidates: [] });
  });
});
