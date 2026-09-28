import { describe, it, expect } from "vitest";
import { IndexEntrySchema, BaselineIndexSchema } from "../../src/validation/schemas";
import { FILE_KINDS, isFileKind, isFileKindRule } from "../../src/domain/testGovernance";

describe("FileKind contract", () => {
  it("uses one runtime value set for config validation and source classification", () => {
    expect(FILE_KINDS).toEqual(["production", "test", "generated", "auxiliary"]);
    expect(isFileKind("test")).toBe(true);
    expect(isFileKind("fixture")).toBe(false);
    expect(isFileKindRule({ pattern: "samples/**", kind: "auxiliary" })).toBe(true);
    expect(isFileKindRule({ pattern: "samples/**", kind: "fixture" })).toBe(false);
    expect(() => IndexEntrySchema.parse({ path: "a.ts", fileKind: "fixture", branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0 })).toThrow();
  });
});

describe("IndexEntrySchema", () => {
  it("accepts valid entry", () => {
    expect(() => IndexEntrySchema.parse({ path: "/abs/a.ts", branchCount: 3, nestingDepth: 2, inDegree: 1, outDegree: 2, alphaStruct: 0.36 })).not.toThrow();
  });
  it("rejects negative branchCount", () => {
    expect(() => IndexEntrySchema.parse({ path: "/abs/a.ts", branchCount: -1, nestingDepth: 2, inDegree: 1, outDegree: 2, alphaStruct: 0.36 })).toThrow();
  });
  it("rejects alphaStruct > 1", () => {
    expect(() => IndexEntrySchema.parse({ path: "/abs/a.ts", branchCount: 3, nestingDepth: 2, inDegree: 1, outDegree: 2, alphaStruct: 1.5 })).toThrow();
  });
  it("strips legacy history-derived CRL from a structural baseline entry", () => {
    const parsed = IndexEntrySchema.parse({ path: "/abs/a.ts", branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0.13, crl: 7.2 });
    expect(parsed).not.toHaveProperty("crl");
  });
  it("carries the report-only call-graph shape facts and rejects out-of-range values", () => {
    const parsed = IndexEntrySchema.parse({
      path: "/abs/a.ts", branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0,
      connectedness: 0.88, singleCallSiteRatio: 0.81,
    });
    expect(parsed.connectedness).toBe(0.88);
    expect(parsed.singleCallSiteRatio).toBe(0.81);
    // 占比值域 [0,1]：越界即契约错误，而不是被静默截断。
    expect(() => IndexEntrySchema.parse({ path: "/abs/a.ts", branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0, singleCallSiteRatio: 1.2 })).toThrow();
    // 旧分片缺少该字段仍然合法（加法事实，不回填）。
    expect(IndexEntrySchema.parse({ path: "/abs/a.ts", branchCount: 0, nestingDepth: 0, inDegree: 0, outDegree: 0, alphaStruct: 0 })).not.toHaveProperty("singleCallSiteRatio");
  });
  it("accepts optional imports + rejects missing path", () => {
    expect(() => IndexEntrySchema.parse({ path: "/abs/a.ts", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 1, alphaStruct: 0.1, imports: ["/abs/b.ts"] })).not.toThrow();
    expect(() => IndexEntrySchema.parse({ branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 1, alphaStruct: 0.1 })).toThrow();
  });
  it("accepts weighted maxFuncBranch decimals", () => {
    expect(() => IndexEntrySchema.parse({
      path: "/abs/a.ts", branchCount: 3.3, nestingDepth: 2, inDegree: 0, outDegree: 1, alphaStruct: 0.2,
      maxFuncBranch: 3.3,
    })).not.toThrow();
  });

  it("accepts the explicit weighted file and top-level branch facts", () => {
    expect(() => IndexEntrySchema.parse({
      path: "/abs/a.ts", branchCount: 3.3, weightedBranchTotal: 3.3, topLevelWeightedBranch: 1.3,
      nestingDepth: 2, inDegree: 0, outDegree: 1, alphaStruct: 0.2, maxFuncBranch: 2,
    })).not.toThrow();
  });

  it("accepts versioned test metrics without making them production metrics", () => {
    expect(IndexEntrySchema.parse({
      path: "packages/core/__tests__/x.test.ts", fileKind: "test", branchCount: 0, nestingDepth: 0,
      inDegree: 0, outDegree: 0, alphaStruct: 0,
      testMetrics: {
        schemaVersion: "1", providerId: "typescript-vitest",
        tests: [{ name: "works", loc: 4, assertionCount: 1, mockCount: 0, statuses: [] }],
      },
    }).fileKind).toBe("test");
  });

  it("keeps v1 test facts readable and accepts v2/v3 optional facts", () => {
    const entry = {
      path: "packages/core/__tests__/x.test.ts", fileKind: "test", branchCount: 0, nestingDepth: 0,
      inDegree: 0, outDegree: 0, alphaStruct: 0,
    };
    expect(() => IndexEntrySchema.parse({ ...entry, testMetrics: {
      schemaVersion: "1", providerId: "typescript-vitest",
      tests: [{ name: "old", loc: 2, assertionCount: 0, mockCount: 0, statuses: [] }],
    } })).not.toThrow();
    expect(() => IndexEntrySchema.parse({ ...entry, testMetrics: {
      schemaVersion: "4", providerId: "typescript-vitest", tests: [],
      moduleAssociations: [{ targetPath: "/abs/subject.ts", source: "../subject", confidence: "medium", testName: "calls", symbol: "subject" }],
    } })).not.toThrow();
    expect(() => IndexEntrySchema.parse({ ...entry, testMetrics: {
      schemaVersion: "2", providerId: "typescript-vitest",
      tests: [{ name: "new", loc: 2, assertionCount: 0, mockCount: 0, statuses: [], testBodyControlFlow: 1.3 }],
    } })).not.toThrow();
    expect(() => IndexEntrySchema.parse({ ...entry, testMetrics: {
      schemaVersion: "3", providerId: "typescript-vitest",
      tests: [], moduleAssociations: [{ targetPath: "/abs/subject.ts", source: "../subject", confidence: "low" }],
    } })).not.toThrow();
  });
});

describe("BaselineIndexSchema", () => {
  it("accepts valid index", () => {
    expect(() => BaselineIndexSchema.parse({
      version: "5.2", meta: { scanAt: "2026-07-05T00:00:00Z", nFiles: 3, languages: ["typescript"] },
    })).not.toThrow();
  });
  it("rejects wrong version prefix", () => {
    expect(() => BaselineIndexSchema.parse({
      version: "4.0", meta: { scanAt: "2026-07-05T00:00:00Z", nFiles: 3, languages: ["typescript"] },
    })).toThrow();
  });
  it("rejects missing meta.nFiles", () => {
    expect(() => BaselineIndexSchema.parse({
      version: "5.2", meta: { scanAt: "2026-07-05T00:00:00Z", languages: ["typescript"] },
    })).toThrow();
  });
  it("preserves an optional sealed structural calibration epoch", () => {
    const profile = {
      id: "structural-calibration-v1:test", version: "structural-calibration-v1" as const, source: "baseline" as const,
      analysisScopeFingerprint: "scope", metricContractVersion: "metrics", populationFingerprint: "a".repeat(64),
      weightsFingerprint: "b".repeat(64),
      p95: { branch: 1, nesting: 1, loc: 1, alpha: 1, oneMinusConnectedness: 1, externalPassthrough: 1 },
    };
    const parsed = BaselineIndexSchema.parse({
      version: "5.2", meta: { scanAt: "2026-07-05T00:00:00Z", nFiles: 3, languages: ["typescript"], calibration: { current: profile, gate: profile } },
    });
    expect(parsed.meta.calibration?.gate?.id).toBe(profile.id);
  });
  it("preserves configSnapshotSha256 in meta (P2-1)", () => {
    const parsed = BaselineIndexSchema.parse({
      version: "5.2",
      meta: { scanAt: "2026-07-05T00:00:00Z", nFiles: 3, languages: ["typescript"], configSnapshotSha256: "c".repeat(64) },
    });
    expect(parsed.meta.configSnapshotSha256).toBe("c".repeat(64));
  });
  /**
   * §6/Q2（2026-09-27）：形状身份必须**穿过 schema**。`z.object` 默认剥掉未声明键，
   * 实测漏登记时 `scan` 读到的指纹非空、写出的 `_index.json` 却没有该字段
   * ——"身份写进了 meta"就成了假陈述。此用例是那道防线的唯一证据。
   */
  it("preserves the optional language-shapes fingerprint in meta (§6/Q2)", () => {
    const parsed = BaselineIndexSchema.parse({
      version: "5.2",
      meta: { scanAt: "2026-07-05T00:00:00Z", nFiles: 3, languages: ["typescript"], shapesFingerprint: "typescript:weak_assertion_methods:toBeTruthy" },
    });
    expect(parsed.meta.shapesFingerprint).toBe("typescript:weak_assertion_methods:toBeTruthy");
    // 未声明（缺字段）与旧 baseline 同形：仍可解析，且不凭空产生该字段。
    const legacy = BaselineIndexSchema.parse({ version: "5.2", meta: { scanAt: "2026-07-05T00:00:00Z", nFiles: 3, languages: ["typescript"] } });
    expect(legacy.meta.shapesFingerprint).toBeUndefined();
  });
  it("preserves per-policy production populations in meta (machine contract input)", () => {
    const parsed = BaselineIndexSchema.parse({
      version: "5.2",
      meta: {
        scanAt: "2026-07-05T00:00:00Z", nFiles: 3, languages: ["typescript"],
        policyPopulations: { "alpha-ts": 38, "beta-go": 12 },
      },
    });
    expect(parsed.meta.policyPopulations).toEqual({ "alpha-ts": 38, "beta-go": 12 });
  });
  it("rejects an unknown present structural calibration version but accepts a legacy index without calibration", () => {
    const base = { version: "5.2", meta: { scanAt: "2026-07-05T00:00:00Z", nFiles: 3, languages: ["typescript"] } };
    expect(() => BaselineIndexSchema.parse(base)).not.toThrow();
    expect(() => BaselineIndexSchema.parse({
      ...base,
      meta: {
        ...base.meta,
        calibration: {
          current: {
            id: "structural-calibration-v2:test", version: "structural-calibration-v2", source: "baseline",
            analysisScopeFingerprint: "scope", metricContractVersion: "metrics", populationFingerprint: "a".repeat(64), weightsFingerprint: "b".repeat(64),
            p95: { branch: 1, nesting: 1, loc: 1, alpha: 1, oneMinusConnectedness: 1, externalPassthrough: 1 },
          },
        },
      },
    })).toThrow();
  });
});
