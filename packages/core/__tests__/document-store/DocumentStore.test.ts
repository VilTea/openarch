import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { capabilityAssetPath, configureSharedDocumentStore, documentRelationsPath, documentScopeRegistryPath, initializeProjectDocumentStore, installDocumentAdvisoryHook, resolveDocumentStore, resolveDocumentStores } from "../../src/document-store/DocumentStore";
import { capabilityDriftSignal } from "../../src/document-store/CapabilityDrift";
import { recordDocumentDisposition, unresolvedSimilarityCandidates } from "../../src/document-store/DocumentDispositions";
import { documentStoreObservability } from "../../src/document-store/DocumentObservability";
import { checkDocuments } from "../../src/document-store/DocumentSimilarity";
import { readGovernanceObservation, recordGovernanceObservation } from "../../src/document-store/GovernanceObservation";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

describe("project-local DocumentStore", () => {
  it("keeps source, relations and derived index under the document store", () => withTemporaryDirectory("document-store", (cwd) => {
    const store = initializeProjectDocumentStore(cwd);

    expect(store.root).toBe(join(cwd, "docs", "openarch"));
    expect(existsSync(join(store.root, "CORE-CAPABILITIES.md"))).toBe(true);
    expect(existsSync(join(store.root, "document-relations.v1.json"))).toBe(true);
    expect(resolveDocumentStore(cwd)?.mode).toBe("project-local");
  }));

  it("updates only changed content and reports same-scope near duplicates", () => withTemporaryDirectory("document-store", (cwd) => {
    const store = initializeProjectDocumentStore(cwd);
    const first = join(store.root, "wisdom", "patterns", "first.md");
    const second = join(store.root, "wisdom", "patterns", "second.md");
    writeFileSync(first, "# Parser boundary\n\nUse one parser authority for every language.");
    writeFileSync(second, "# Parser boundary\n\nUse one parser authority for every supported language.");

    const initial = checkDocuments({ store });
    expect(initial.indexed).toBeGreaterThanOrEqual(3);
    writeFileSync(first, "# Parser boundary\n\nUse one parser authority for every supported language.");
    const changed = checkDocuments({ store, changedPaths: [first] });

    expect(changed.updated).toBe(1);
    expect(changed.candidates.some((candidate) => candidate.left.endsWith("first.md") || candidate.right.endsWith("first.md"))).toBe(true);
    expect(readGovernanceObservation(store.scopeRoot, "document-similarity")?.status).toBe("success");
    expect(readGovernanceObservation(store.scopeRoot, "capability-maintenance")).toBeUndefined();
    expect(readFileSync(join(store.scopeRoot, ".openarch", ".gitignore"), "utf8")).toContain("governance-observations.v1.json");
  }));

  it("records capability maintenance only after its changed content is checked", () => withTemporaryDirectory("document-store", (cwd) => {
    const store = initializeProjectDocumentStore(cwd);
    const capabilities = capabilityAssetPath(store);
    writeFileSync(capabilities, "# Core capabilities\n\n| Capability | Contract |\n|---|---|\n");

    checkDocuments({ store, changedPaths: [capabilities] });

    expect(readGovernanceObservation(store.scopeRoot, "capability-maintenance")?.status).toBe("success");
  }));

  it("installs an advisory hook in the document Git root without replacing foreign hooks", () => withTemporaryDirectory("document-store", (cwd) => {
    mkdirSync(join(cwd, ".git", "hooks"), { recursive: true });
    const store = initializeProjectDocumentStore(cwd);
    expect(installDocumentAdvisoryHook(store)).toBe("installed");
    expect(installDocumentAdvisoryHook(store)).toBe("updated");
    expect(readFileSync(join(cwd, ".git", "hooks", "pre-commit"), "utf8")).toContain("OPENARCH_BIN");
  }));

  it("runs the installed document hook from its Git root through OPENARCH_BIN", () => withTemporaryDirectory("document-store", (cwd) => {
    execFileSync("git", ["init", "--quiet"], { cwd });
    execFileSync("git", ["config", "user.email", "openarch@example.test"], { cwd });
    execFileSync("git", ["config", "user.name", "OpenArch Test"], { cwd });
    const store = initializeProjectDocumentStore(cwd);
    installDocumentAdvisoryHook(store);
    const marker = join(cwd, "hook-marker.txt");
    const launcher = join(cwd, "openarch-stub");
    writeFileSync(launcher, "#!/bin/sh\npwd > \"$OPENARCH_MARKER\"\nprintf '%s\\n' \"$@\" > \"$OPENARCH_MARKER.args\"\n");
    chmodSync(launcher, 0o755);
    writeFileSync(join(store.root, "decision.md"), "# Decision\n");
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "--quiet", "-m", "hook context"], {
      cwd,
      env: { ...process.env, OPENARCH_BIN: launcher.replace(/\\/g, "/"), OPENARCH_MARKER: marker },
    });

    const hookCwd = readFileSync(marker, "utf8").trim().replace(/\\/g, "/").toLowerCase();
    expect(hookCwd).toContain("/openarch-document-store-");
    expect(readFileSync(`${marker}.args`, "utf8")).toBe("docs\ncheck\n--staged\n");
  }));

  it("adds the runtime observation ignore rule when an existing scope is first observed", () => withTemporaryDirectory("document-store", (scopeRoot) => {
    mkdirSync(join(scopeRoot, ".openarch"), { recursive: true });
    writeFileSync(join(scopeRoot, ".openarch", ".gitignore"), "document-index.v1.json\n");

    recordGovernanceObservation(scopeRoot, "document-similarity", {
      status: "success", at: "2026-07-17T00:00:00.000Z", inputFingerprint: "input",
    });

    expect(readFileSync(join(scopeRoot, ".openarch", ".gitignore"), "utf8")).toBe("document-index.v1.json\ngovernance-observations.v1.json\n");
  }));

  it("reports generated record templates whose required sections are still placeholders", () => withTemporaryDirectory("document-store", (cwd) => {
    const store = initializeProjectDocumentStore(cwd);
    const template = join(store.root, "wisdom", "patterns", "open.md");
    writeFileSync(template, "# Open question\n来源: openarch docs record\n\n## 背景\n<!-- 必填：什么改动触发了这条记录？ -->\n");

    const opened = checkDocuments({ store, changedPaths: [template] });

    expect(opened.unfilled).toEqual(["wisdom/patterns/open.md"]);
    writeFileSync(template, "# Open question\n来源: openarch docs record\n\n## 背景\n模型替换了权威解析器。\n");
    const filled = checkDocuments({ store, changedPaths: [template] });
    expect(filled.unfilled).toEqual([]);
  }));

  it("detects unfilled English record templates by their localized markers", () => withTemporaryDirectory("document-store", (cwd) => {
    const store = initializeProjectDocumentStore(cwd);
    const template = join(store.root, "wisdom", "patterns", "localized.md");
    writeFileSync(template, "# Open question\nSource: openarch docs record\n\n## Background\n<!-- REQUIRED: what change triggered this record? -->\n");

    expect(checkDocuments({ store, changedPaths: [template] }).unfilled).toEqual(["wisdom/patterns/localized.md"]);
    writeFileSync(template, "# Open question\nSource: openarch docs record\n\n## Background\nThe parser authority moved to one module.\n");
    expect(checkDocuments({ store, changedPaths: [template] }).unfilled).toEqual([]);
  }));

  it("never flags capability assets that merely quote the record markers", () => withTemporaryDirectory("document-store", (cwd) => {
    const store = initializeProjectDocumentStore(cwd);
    const capabilities = capabilityAssetPath(store);
    writeFileSync(capabilities, "# Capabilities\n\nRecords use `<!-- 必填/REQUIRED -->` and a provenance line like `来源/Source: openarch docs record`.\n");

    expect(checkDocuments({ store, changedPaths: [capabilities] }).unfilled).toEqual([]);
  }));

  it("persists similarity dispositions and exposes only unresolved candidates", () => withTemporaryDirectory("document-store", (cwd) => {
    const store = initializeProjectDocumentStore(cwd);
    const first = join(store.root, "wisdom", "patterns", "first.md");
    const second = join(store.root, "wisdom", "patterns", "second.md");
    writeFileSync(first, "# Parser boundary\n\nUse one parser authority for every language.");
    writeFileSync(second, "# Parser boundary\n\nUse one parser authority for every supported language.");
    checkDocuments({ store });

    expect(unresolvedSimilarityCandidates(store).length).toBeGreaterThan(0);
    const outcome = recordDocumentDisposition(store, {
      left: "wisdom/patterns/first.md",
      right: "wisdom/patterns/second.md",
      decision: "merged",
      note: "same boundary, one authority",
      at: "2026-08-16T00:00:00.000Z",
    });
    expect("error" in outcome).toBe(false);
    expect(unresolvedSimilarityCandidates(store)).toEqual([]);
    expect(JSON.parse(readFileSync(documentRelationsPath(store), "utf8")).dispositions).toHaveLength(1);
  }));

  it("surfaces document-store observability without writing state", () => withTemporaryDirectory("document-store", (cwd) => {
    const store = initializeProjectDocumentStore(cwd);
    const before = documentStoreObservability(store);
    expect(before.scopeId).toBe("repository-local");
    expect(before.indexed).toBe(0);
    expect(before.openCandidates).toBe(0);
    expect(before.unfilled).toEqual([]);
    checkDocuments({ store });
    const after = documentStoreObservability(store);
    expect(after.indexed).toBeGreaterThanOrEqual(1);
  }));

  it("derives report-only capability drift from governance.capability_watch", async () => withTemporaryDirectory("document-store", async (cwd) => {
    const store = initializeProjectDocumentStore(cwd);
    writeFileSync(join(cwd, ".openarch", "config.yml"), "governance:\n  persistence: tracked\n  capability_watch:\n    - packages/core/src/**/*.ts\n");

    expect(await capabilityDriftSignal(cwd, ["packages/core/src/index.ts"])).toEqual({
      watch: ["packages/core/src/**/*.ts"],
      matched: ["packages/core/src/index.ts"],
    });
    const asset = capabilityAssetPath(store);
    const assetPath = asset.replace(/\\/g, "/").replace(`${cwd.replace(/\\/g, "/")}/`, "");
    expect((await capabilityDriftSignal(cwd, [assetPath])).matched).toEqual([]);
    expect((await capabilityDriftSignal(cwd, [])).matched).toEqual([]);
  }));

  it("keeps invalid capability_watch configuration report-only", async () => withTemporaryDirectory("document-store", async (cwd) => {
    initializeProjectDocumentStore(cwd);
    writeFileSync(join(cwd, ".openarch", "config.yml"), "governance:\n  capability_watch: not-a-list\n");
    expect(await capabilityDriftSignal(cwd, ["packages/core/src/index.ts"])).toMatchObject({
      watch: [],
      matched: [],
      error: expect.stringContaining("capability_watch"),
    });
  }));
});

describe("shared DocumentStore scopes", () => {
  it("registers the scope in the docs Git root and resolves it from that root", () => withTemporaryDirectory("document-store", (project) => withTemporaryDirectory("document-store-docs", (docs) => {
    mkdirSync(join(project, ".openarch", "docs-repo"), { recursive: true });
    mkdirSync(join(docs, ".git"), { recursive: true });
    writeFileSync(join(project, ".openarch", ".docs-repo-config.json"), JSON.stringify({
      version: "5.2", target: docs, type: "local", cloned_at: "2026-07-16T00:00:00.000Z", auto_sync: false,
    }));

    const configured = configureSharedDocumentStore(project, "projects/service-a", "repository:service-a");

    if ("error" in configured) throw new Error(configured.error);
    expect(JSON.parse(readFileSync(documentScopeRegistryPath(docs), "utf8"))).toEqual({
      version: "1",
      scopes: [{ id: "repository:service-a", root: "projects/service-a" }],
    });
    expect(resolveDocumentStore(project)?.scopeId).toBe("repository:service-a");
    expect(resolveDocumentStores(docs)).toMatchObject([{ scopeId: "repository:service-a", scopeRoot: join(docs, "projects", "service-a") }]);
    expect(capabilityAssetPath(configured)).toBe(join(docs, "projects", "service-a", "CORE-CAPABILITIES.md"));
  })));
});
