import { describe, expect, it } from "vitest";
import { assessSymbolScopeAdmissions } from "../../src/application/symbolScopeAdmission";
import type { SymbolVersionPairReport } from "../../src/domain/symbolVersionPair";
import type { SymbolUseReport } from "../../src/symbol-use/types";

const versionPairFixture = (): SymbolVersionPairReport => ({
  language: "typescript",
  availability: "available",
  population: { beforeRevision: "before-head", afterRevision: "HEAD", files: ["src/api.ts"], fingerprint: "pop-a" },
  before: {
    origin: { language: "typescript", providerId: "typescript-symbol-use", evidenceSource: "compiler" },
    state: { availability: "available", coverage: { declarations: "complete", repositoryReferences: "complete" } },
    facts: [{
      language: "typescript",
      declaration: { file: "src/api.ts", name: "publish", kind: "function", line: 10 },
      publicSurface: "declared-public",
      repositoryReferences: [{ file: "src/consumer.ts", line: 2 }],
    }],
  },
  after: {
    origin: { language: "typescript", providerId: "typescript-symbol-use", evidenceSource: "compiler" },
    state: { availability: "available", coverage: { declarations: "complete", repositoryReferences: "complete" } },
    facts: [{
      language: "typescript",
      declaration: { file: "src/api.ts", name: "publish", kind: "function", line: 10 },
      publicSurface: "declared-public",
      repositoryReferences: [{ file: "src/consumer.ts", line: 2 }],
    }],
  },
  declarations: [{
    identity: "typescript\0src/api.ts\0function\0publish",
    status: "matched",
    before: { language: "typescript", declaration: { file: "src/api.ts", name: "publish", kind: "function", line: 10 }, publicSurface: "declared-public", repositoryReferences: [{ file: "src/consumer.ts", line: 2 }] },
    after: { language: "typescript", declaration: { file: "src/api.ts", name: "publish", kind: "function", line: 10 }, publicSurface: "declared-public", repositoryReferences: [{ file: "src/consumer.ts", line: 2 }] },
  }],
});

describe("symbol-scope admission projection", () => {
  it("does not promote a worktree-only partial symbol fact into formula evidence", () => {
    const admissions = assessSymbolScopeAdmissions([{
      file: "src/api.go", changes: [{ anchor: "Publish", kind: "public_method_sig" }], beforeState: "git",
    }], [{
      origin: { language: "go", providerId: "go-gopls-symbol-use", evidenceSource: "lsp" },
      state: { availability: "partial", coverage: { declarations: "partial", repositoryReferences: "partial" }, reason: "demand-driven semantic query selected 1/20 governed declaration files" },
      facts: [{ language: "go", declaration: { file: "src/api.go", name: "Publish", kind: "function", line: 3 }, publicSurface: "declared-public", repositoryReferences: [{ file: "src/client.go", line: 4 }] }],
    }]);

    expect(admissions).toEqual([expect.objectContaining({
      availability: "partial", eligible: false, language: "go", symbol: "Publish",
      requirements: expect.arrayContaining([
        expect.objectContaining({ id: "before_declaration_identity", availability: "unavailable" }),
        expect.objectContaining({ id: "after_declaration_identity", availability: "partial" }),
        expect.objectContaining({ id: "repository_references", availability: "partial" }),
        expect.objectContaining({ id: "public_surface", availability: "available" }),
      ]),
    })]);
  });

  it("promotes before/after declaration identity when a version pair confirms the changed symbol", () => {
    const pair = versionPairFixture();
    const admissions = assessSymbolScopeAdmissions([{
      file: "src/api.ts", changes: [{ anchor: "publish", kind: "public_method_sig" }], beforeState: "git",
    }], [pair.after!], [pair]);

    expect(admissions).toEqual([expect.objectContaining({
      availability: "partial", symbol: "publish", language: "typescript",
      requirements: expect.arrayContaining([
        expect.objectContaining({ id: "before_declaration_identity", availability: "available" }),
        expect.objectContaining({ id: "after_declaration_identity", availability: "available" }),
      ]),
    })]);
  });

  it("promotes common_population when the changed file is in the version-pair common population", () => {
    const pair = versionPairFixture();
    const admissions = assessSymbolScopeAdmissions([{
      file: "src/api.ts", changes: [{ anchor: "publish", kind: "public_method_sig" }], beforeState: "git",
    }], [pair.after!], [pair]);

    // src/api.ts 在 versionPair population.files（before/after 共同治理文件集）→ common_population available
    expect(admissions).toEqual([expect.objectContaining({
      requirements: expect.arrayContaining([
        expect.objectContaining({ id: "common_population", availability: "available" }),
      ]),
    })]);
  });

  it("keeps common_population unavailable when the file is absent from the common population", () => {
    const pair = versionPairFixture();
    // 变更文件 src/other.ts 不在 population.files（src/api.ts）中，但 after report 有该符号
    const admissions = assessSymbolScopeAdmissions([{
      file: "src/other.ts", changes: [{ anchor: "publish", kind: "public_method_sig" }], beforeState: "git",
    }], [{
      ...pair.after!,
      facts: [{
        language: "typescript",
        declaration: { file: "src/other.ts", name: "publish", kind: "function", line: 3 },
        publicSurface: "declared-public",
        repositoryReferences: [{ file: "src/client.ts", line: 4 }],
      }],
    }], [pair]);

    expect(admissions).toEqual([expect.objectContaining({
      requirements: expect.arrayContaining([
        expect.objectContaining({ id: "common_population", availability: "unavailable" }),
      ]),
    })]);
  });

  it("marks calibration_samples available only when durable samples exist", () => {
    const pair = versionPairFixture();
    const profiles = [{ file: "src/api.ts", changes: [{ anchor: "publish", kind: "public_method_sig" }], beforeState: "git" }];
    const reports = [pair.after!];
    // 无 durable 样本 → partial
    expect(assessSymbolScopeAdmissions(profiles, reports, [pair])).toEqual([expect.objectContaining({
      requirements: expect.arrayContaining([expect.objectContaining({ id: "calibration_samples", availability: "partial" })]),
    })]);
    // 有 durable 样本 → available
    expect(assessSymbolScopeAdmissions(profiles, reports, [pair], true)).toEqual([expect.objectContaining({
      requirements: expect.arrayContaining([expect.objectContaining({ id: "calibration_samples", availability: "available" })]),
    })]);
  });
});
