import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectGovernanceStatus } from "../../src/application/status";
import { createAnalysisScope } from "../../src/domain/analysisScope";
import { sourceSnapshotSha256 } from "../../src/projectFiles";
import { baselineShardFileName } from "../../src/adapter/storage/BaselineShard";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("status", () => {
  it("reads a relative OpenArch baseline from the requested project root", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openarch-status-"));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, ".openarch", "baseline"), { recursive: true });
    writeFileSync(join(cwd, ".openarch", "baseline", "_index.json"), JSON.stringify({ meta: { nFiles: 7 } }));

    expect(projectGovernanceStatus(cwd).baseline).toMatchObject({ exists: true, nFiles: 7, scope: "unknown", freshness: "unknown", generation: { active: "invalid" } });
  });

  it("distinguishes a current complete source snapshot from a stale one", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openarch-status-snapshot-"));
    temporaryDirectories.push(cwd);
    const source = join(cwd, "src", "value.ts");
    mkdirSync(join(cwd, ".openarch", "baseline"), { recursive: true });
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, ".openarch", "config.yml"), 'languages: ["typescript"]\n');
    writeFileSync(source, "export const value = 1;\n");
    const scope = createAnalysisScope(["typescript"]);
    const fingerprint = sourceSnapshotSha256([source], cwd)!;
    writeFileSync(join(cwd, ".openarch", "baseline", "_index.json"), JSON.stringify({
      meta: { nFiles: 1, scanAt: "2026-08-01T00:00:00.000Z", analysisScope: { fingerprint: scope.fingerprint, complete: true }, sourceSnapshotSha256: fingerprint },
    }));

    expect(projectGovernanceStatus(cwd).baseline).toMatchObject({ exists: true, scope: "compatible", freshness: "current" });
    writeFileSync(source, "export const value = 2;\n");
    expect(projectGovernanceStatus(cwd).baseline).toMatchObject({ exists: true, scope: "compatible", freshness: "stale" });
  });

  it("exposes interrupted baseline generations without mutating them", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openarch-status-generations-"));
    temporaryDirectories.push(cwd);
    const baseline = join(cwd, ".openarch", "baseline");
    const backup = join(cwd, ".openarch", "baseline.backup-test");
    const staging = join(cwd, ".openarch", "baseline.staging-test");
    mkdirSync(baseline, { recursive: true });
    mkdirSync(backup, { recursive: true });
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(baseline, "_index.json"), "{}", "utf8");
    writeFileSync(join(backup, "_index.json"), JSON.stringify({
      version: "5.2", meta: { scanAt: "2026-08-01T00:00:00.000Z", nFiles: 0, languages: ["typescript"] },
    }), "utf8");
    writeFileSync(join(staging, "_index.json"), "{ broken", "utf8");

    const report = projectGovernanceStatus(cwd);
    expect(report.baseline.generation).toMatchObject({ active: "invalid", readable: "backup" });
    expect(report.baseline.generation?.artifacts).toHaveLength(2);
    expect(report.baseline.generation?.artifacts.map((artifact) => artifact.kind)).toEqual(["backup", "staging"]);
  });

  it("reports a readable backup when the active generation is missing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openarch-status-backup-"));
    temporaryDirectories.push(cwd);
    const backup = join(cwd, ".openarch", "baseline.backup-test");
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, "_index.json"), JSON.stringify({
      version: "5.2", meta: { scanAt: "2026-08-01T00:00:00.000Z", nFiles: 0, languages: ["typescript"] },
    }), "utf8");

    expect(projectGovernanceStatus(cwd).baseline).toMatchObject({
      exists: true, nFiles: 0, generation: { active: "missing", readable: "backup" },
    });
  });

  it("uses the newest valid backup when multiple recovery candidates exist", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openarch-status-backup-order-"));
    temporaryDirectories.push(cwd);
    for (const [name, nFiles] of [["baseline.backup-20260801", 1], ["baseline.backup-20260802", 2]] as const) {
      const directory = join(cwd, ".openarch", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "_index.json"), JSON.stringify({
        version: "5.2", meta: { scanAt: "2026-08-01T00:00:00.000Z", nFiles, languages: ["typescript"] },
      }), "utf8");
      for (let index = 0; index < nFiles; index += 1) {
        const entry = { path: `src/file-${index}.ts`, branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
        writeFileSync(join(directory, baselineShardFileName(entry.path)), JSON.stringify(entry), "utf8");
      }
    }

    expect(projectGovernanceStatus(cwd).baseline.nFiles).toBe(2);
  });

  it("reports declared architecture policy coverage without evaluating its rules", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openarch-status-policy-"));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, ".openarch"), { recursive: true });
    writeFileSync(join(cwd, ".openarch", "config.yml"), "rules_warn: []\nrules_block: []\n");
    expect(projectGovernanceStatus(cwd).architecturePolicy).toEqual({ state: "unconfigured", declaredRules: 0 });

    writeFileSync(join(cwd, ".openarch", "config.yml"), "rules_warn:\n  - name: branch\n    condition: max_func_branch > 5\n");
    expect(projectGovernanceStatus(cwd).architecturePolicy).toEqual({ state: "configured", declaredRules: 1 });
  });
});
