import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { governanceReadiness } from "../../src/application/governanceReadiness";
import { configureSharedDocumentStore, initializeProjectDocumentStore } from "../../src/document-store/DocumentStore";
import { checkDocuments } from "../../src/document-store/DocumentSimilarity";

const temporaryRoots: string[] = [];
const originalOpenarchBin = process.env.OPENARCH_BIN;
const tempDir = () => {
  const path = join(tmpdir(), `openarch-readiness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  temporaryRoots.push(path);
  return path;
};

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
  if (originalOpenarchBin === undefined) delete process.env.OPENARCH_BIN;
  else process.env.OPENARCH_BIN = originalOpenarchBin;
});

describe("governanceReadiness", () => {
  it("reports an unobserved project-local similarity check without treating it as configured failure", () => {
    const project = tempDir();
    initializeProjectDocumentStore(project);

    expect(governanceReadiness(project).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "document-store", state: "ready" }),
      expect.objectContaining({ id: "document-similarity", state: "not_observed" }),
      expect.objectContaining({ id: "capability-asset", state: "ready" }),
      expect.objectContaining({ id: "capability-maintenance", state: "not_observed" }),
    ]));
  });

  it("marks capability maintenance stale when the asset changes after its check", () => {
    const project = tempDir();
    const store = initializeProjectDocumentStore(project);
    const capabilities = join(store.scopeRoot, "CORE-CAPABILITIES.md");
    checkDocuments({ store, changedPaths: [capabilities] });
    expect(governanceReadiness(project).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "capability-maintenance", state: "ready" }),
    ]));

    writeFileSync(capabilities, "# 核心能力资产\n\n已修改但未检查。\n");
    expect(governanceReadiness(project).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "capability-maintenance", state: "not_observed" }),
    ]));
  });

  it("checks the shared registry, document hook and hook executable separately", () => {
    const project = tempDir();
    const docs = tempDir();
    mkdirSync(join(project, ".openarch", "docs-repo"), { recursive: true });
    mkdirSync(join(docs, ".git", "hooks"), { recursive: true });
    writeFileSync(join(project, ".openarch", ".docs-repo-config.json"), JSON.stringify({
      version: "5.2", target: docs, type: "local", cloned_at: "2026-07-17T00:00:00.000Z", auto_sync: false,
    }));
    expect("error" in configureSharedDocumentStore(project, "projects/service-a", "repository:service-a")).toBe(false);
    writeFileSync(
      join(docs, ".git", "hooks", "pre-commit"),
      "# OpenArch document advisory hook\nOPENARCH_BIN=\"${OPENARCH_BIN:-openarch}\"\n",
    );
    process.env.OPENARCH_BIN = join(docs, "missing-openarch");

    expect(governanceReadiness(project).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "document-scope", state: "ready" }),
      expect.objectContaining({ id: "document-hook", state: "ready" }),
      expect.objectContaining({ id: "document-hook-runtime", state: "unavailable" }),
      expect.objectContaining({ id: "document-similarity", state: "not_observed" }),
    ]));
  });
});
