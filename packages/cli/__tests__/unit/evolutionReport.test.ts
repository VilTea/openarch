import { describe, expect, it } from "vitest";
import { renderEvolutionReport, renderEvolutionUnavailable } from "../../src/report/evolutionReport";

const coordination = {
  coordinator: "src/parser/factory.ts",
  members: ["src/parser/java.ts", "src/parser/rust.ts"],
  events: [
    { member: "src/parser/java.ts", commitId: "first" },
    { member: "src/parser/rust.ts", commitId: "second" },
  ],
  coordinatorLoc: 20,
  averageMemberLoc: 70,
  directImportCount: 4,
  commitCount: 2,
  occurrences: 2,
  historyEntries: ["0123456789abcdef", "second"],
  maxInDegree: 3,
  maxAlphaStruct: 0.4,
  historicalEvidence: { status: "confirmed" as const, inspectedEvents: 2, confirmedEvents: 2, unavailableEvents: 0 },
};

const surface = {
  coordinator: coordination.coordinator,
  files: ["src/parser/factory.ts", "src/languageSupport.ts"],
  extensionMembers: coordination.members,
  extensionCommitCount: 2,
  occurrences: 2,
  minimumMemberCoverage: 1,
  averageBatchSize: 2,
  currentInternalImportCount: 1,
  currentImportComponents: 1,
  actionSummary: { added: 0, modified: 4, deleted: 0, observedCommits: 2 },
  historyEntries: ["first", "second"],
  supportingCommits: ["first", "second"],
  maxInDegree: 3,
  maxAlphaStruct: 0.4,
  coordinationEvidence: coordination.historicalEvidence,
};

const report = (overrides: Partial<Parameters<typeof renderEvolutionReport>[0]> = {}) => ({
  eligibleChangeSets: 12,
  bootstrapChangeSetsExcluded: 2,
  unavailableHistoryFiles: 0,
  coordinationCandidates: [coordination],
  extensionSurfaces: { availability: "available" as const, candidates: [surface] },
  cochangeSets: { availability: "available" as const, candidates: [] },
  ...overrides,
});

describe("renderEvolutionReport", () => {
  it("renders a coordinator and its stable multi-write surface in one dossier", () => {
    const output = renderEvolutionReport(report()).join("\n");

    expect(output).toContain("### 调查队列");
    expect(output).toContain("### 1. src/parser/factory.ts");
    expect(output).toContain("稳定多写面: src/parser/factory.ts + src/languageSupport.ts");
    expect(output).toContain("成员: src/parser/java.ts, src/parser/rust.ts");
    expect(output).toContain("0123456789ab, second");
    expect(output).not.toContain("扩展接入面（协调面约束的低阈值闭集）");
    expect(output.match(/src\/parser\/factory\.ts/g)).toHaveLength(2);
  });

  it("keeps a coordinator visible when no stable multi-write surface formed", () => {
    const output = renderEvolutionReport(report({ extensionSurfaces: { availability: "available", candidates: [] } })).join("\n");

    expect(output).toContain("src/parser/factory.ts");
    expect(output).toContain("稳定多写面: 尚未形成可复核的重复既有表面");
  });

  it("keeps co-change evidence compact and secondary", () => {
    const output = renderEvolutionReport(report({
      cochangeSets: {
        availability: "available",
        candidates: [{
          files: ["src/a.ts", "src/b.ts", "src/c.ts"], occurrences: 3, minimumMemberCoverage: 1, averageBatchSize: 3,
          currentInternalImportCount: 2, currentImportComponents: 1,
          actionSummary: { added: 1, modified: 2, deleted: 0, observedCommits: 3 },
          historyEntries: ["first"], supportingCommits: ["first", "second", "third"], maxInDegree: 0, maxAlphaStruct: 0,
        }],
      },
    })).join("\n");

    expect(output).toContain("### 闭合共变背景");
    expect(output).toContain("3 文件 / 3 次");
    expect(output).not.toContain("#### 1. 3 文件");
  });

  it("keeps unavailable history distinct from an empty dossier list", () => {
    expect(renderEvolutionUnavailable("not a Git repository").join("\n")).toContain("状态: UNAVAILABLE");
  });
});
