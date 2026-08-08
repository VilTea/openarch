import { describe, expect, it } from "vitest";
import {
  buildSymbolCalibrationProfile,
  createSymbolCalibrationSample,
  parseSymbolCalibrationProfile,
  symbolCommonPopulationFingerprint,
} from "../../src/domain/symbolCalibration";
import type { SymbolVersionPairReport } from "../../src/domain/symbolVersionPair";

const fact = (name: string, file = "src/api.ts") => ({
  language: "typescript",
  declaration: { file, name, kind: "function" as const, line: 1 },
  repositoryReferences: [{ file: "src/consumer.ts", line: 2 }],
  publicSurface: "internal" as const,
});

const report = (options: {
  readonly files?: readonly string[];
  readonly status?: "matched" | "added" | "removed" | "ambiguous";
  readonly family?: "callable" | "type" | "property";
  readonly providerIds?: readonly [string, string];
  readonly availability?: "available" | "partial" | "unavailable";
} = {}): SymbolVersionPairReport => {
  const files = options.files ?? ["src/api.ts", "src/consumer.ts"];
  const status = options.status ?? "matched";
  const family = options.family ?? "callable";
  const availability = options.availability ?? "available";
  const beforeProvider = options.providerIds?.[0] ?? "typescript-symbol-use";
  const afterProvider = options.providerIds?.[1] ?? beforeProvider;
  const before = {
    origin: { language: "typescript", providerId: beforeProvider, evidenceSource: "compiler" as const },
    state: { availability, coverage: { declarations: availability === "available" ? "complete" as const : "partial" as const, repositoryReferences: availability === "available" ? "complete" as const : "partial" as const } },
    scope: { mode: "repository" as const, governedFileCount: files.length, selectedDeclarationFileCount: 1, declarationFamilies: [family] },
    facts: [fact("worker")],
  };
  const after = {
    ...before,
    origin: { ...before.origin, providerId: afterProvider },
    facts: [fact("worker")],
  };
  return {
    language: "typescript",
    availability,
    population: { beforeRevision: "before", afterRevision: "after", files, fingerprint: "revision-fingerprint" },
    before,
    after,
    declarations: [{ identity: "typescript\0src/api.ts\0function\0worker", status, ...(status === "removed" ? { before: fact("worker") } : {}), ...(status === "added" ? { after: fact("worker") } : {}), ...(status === "matched" ? { before: fact("worker"), after: fact("worker") } : {}) }],
  };
};

describe("symbol calibration", () => {
  it("uses a revision-independent fingerprint for the fixed common population", () => {
    expect(symbolCommonPopulationFingerprint(["src/b.ts", "src/a.ts"])).toBe(symbolCommonPopulationFingerprint(["src/a.ts", "src/b.ts", "src/a.ts"]));
  });

  it("requires one complete positive and one complete negative sample", () => {
    const positive = createSymbolCalibrationSample(report(), { id: "positive", identity: "typescript\0src/api.ts\0function\0worker", expected: "matched" });
    const negative = createSymbolCalibrationSample(report({ status: "removed" }), { id: "negative", identity: "typescript\0src/api.ts\0function\0worker", expected: "rejected" });
    const profile = buildSymbolCalibrationProfile([positive, negative]);

    expect(profile).toMatchObject({ eligible: true, availability: "available", positiveSampleCount: 1, negativeSampleCount: 1 });
    expect(parseSymbolCalibrationProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
  });

  it("keeps differing populations report-only", () => {
    const positive = createSymbolCalibrationSample(report(), { id: "positive", identity: "typescript\0src/api.ts\0function\0worker", expected: "matched" });
    const negative = createSymbolCalibrationSample(report({ files: ["src/api.ts"] , status: "removed" }), { id: "negative", identity: "typescript\0src/api.ts\0function\0worker", expected: "rejected" });
    const profile = buildSymbolCalibrationProfile([positive, negative]);

    expect(profile.eligible).toBe(false);
    expect(profile.availability).toBe("partial");
    expect(profile.reasons).toContain("samples must share one common population fingerprint");
  });

  it("does not turn ambiguous or incomplete evidence into a calibration", () => {
    const ambiguous = createSymbolCalibrationSample(report({ status: "ambiguous" }), { id: "ambiguous", identity: "typescript\0src/api.ts\0function\0worker", expected: "matched" });
    const incomplete = createSymbolCalibrationSample(report({ availability: "partial" }), { id: "incomplete", identity: "typescript\0src/api.ts\0function\0worker", expected: "matched" });

    expect(ambiguous).toMatchObject({ observed: "ambiguous", availability: "partial" });
    expect(incomplete).toMatchObject({ observed: "matched", availability: "partial" });
    expect(buildSymbolCalibrationProfile([ambiguous, incomplete]).eligible).toBe(false);
  });

  it("preserves unknown declaration families and provider drift as unavailable calibration", () => {
    const base = report();
    const unknownFamilyReport = {
      ...base,
      before: { ...base.before!, scope: { ...base.before!.scope!, declarationFamilies: ["callable", "type"] } },
    };
    const unknown = createSymbolCalibrationSample(unknownFamilyReport, { id: "unknown", identity: "typescript\0src/api.ts\0function\0worker", expected: "matched" });
    const providerDrift = createSymbolCalibrationSample(report({ providerIds: ["before", "after"] }), { id: "drift", identity: "typescript\0src/api.ts\0function\0worker", expected: "matched" });

    expect(unknown).toMatchObject({ declarationFamily: "callable", availability: "available" });
    expect(providerDrift).toMatchObject({ providerId: "none", availability: "partial" });
  });

  it("keeps a missing or ambiguous target identity unknown even when the report has a declared family", () => {
    const missing = createSymbolCalibrationSample(report(), { id: "missing", identity: "typescript\0src/api.ts\0function\0absent", expected: "rejected" });
    expect(missing).toMatchObject({ declarationFamily: "unknown", observed: "unavailable", availability: "partial" });
  });

  it("rejects malformed persisted profiles", () => {
    expect(() => parseSymbolCalibrationProfile({ schemaVersion: 1, samples: [] })).toThrow("invalid symbol calibration profile fields");
  });
});
