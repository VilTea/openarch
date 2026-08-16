import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectBaselineGenerations } from "../../src/adapter/storage/BaselineGenerationDiagnostics";
import { makeJsonFileStorageLive } from "../../src/adapter/storage/JsonFileStorage";
import { StorageService } from "../../src/port/StorageService";

describe("BaselineGenerationDiagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "openarch-generation-diag-"));
  const layer = makeJsonFileStorageLive(root);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("shallow mode stays fast-valid for an intact generation and flags identity drift only in deep mode", async () => {
    const entry = { path: "src/diag.ts", branchCount: 1, nestingDepth: 1, inDegree: 0, outDegree: 0, alphaStruct: 0.1 };
    const index = { version: "5.2", meta: { scanAt: "2026-08-15T00:00:00.000Z", nFiles: 1, languages: ["typescript"] } };
    await Effect.runPromise(Effect.gen(function* () {
      const storage = yield* StorageService;
      yield* storage.writeBaseline({ entries: [entry], index });
    }).pipe(Effect.provide(layer)));

    expect(inspectBaselineGenerations(root, Date.now(), { deep: false }).active).toBe("valid");
    expect(inspectBaselineGenerations(root).active).toBe("valid");

    const indexPath = join(root, "baseline", "_index.json");
    const persisted = JSON.parse(readFileSync(indexPath, "utf8"));
    writeFileSync(indexPath, JSON.stringify({ ...persisted, meta: { ...persisted.meta, snapshotSha256: "0".repeat(64) } }));

    // Shallow diagnostics deliberately do not recompute the content-addressed
    // identity; full validation stays on scan/review/gate read paths.
    expect(inspectBaselineGenerations(root, Date.now(), { deep: false }).active).toBe("valid");
    expect(inspectBaselineGenerations(root).active).toBe("invalid");
  });
});
