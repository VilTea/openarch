import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectTypeScriptSemanticRelations } from "../../src/semantic-relations/typescript";
import { semanticEvidenceView } from "../support/semanticEvidence";

describe("collectTypeScriptSemanticRelations", () => {
  it("reports direct compiler-resolved class and interface relationships", () => {
    const cwd = join(tmpdir(), `openarch-semantic-relations-${Date.now()}`);
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }));
    writeFileSync(join(cwd, "src", "relations.ts"), [
      "interface Contract {}",
      "class Base {}",
      "class Dependency {}",
      "class Consumer extends Base implements Contract {",
      "  field: ReadonlyArray<Dependency>;",
      "  constructor(dependency: Dependency) { this.field = [dependency]; }",
      "  build(input: Dependency): Dependency { return new Dependency(); }",
      "}",
    ].join("\n"));

    const report = collectTypeScriptSemanticRelations(cwd);
    const kinds = report.facts.filter((fact) => fact.source.name === "Consumer").map((fact) => fact.kind);

    expect(report).toMatchObject({
      origin: { language: "typescript", providerId: "typescript-semantic-relations", evidenceSource: "compiler" },
      state: { availability: "available", coverage: { symbols: "complete", relations: "complete" } },
    });
    expect(semanticEvidenceView(report)).toMatchObject({
      providerId: "typescript-semantic-relations",
      evidenceSource: "compiler",
      availability: "available",
      coverage: { symbols: "complete", relations: "complete" },
    });
    expect(kinds).toEqual(expect.arrayContaining(["extends", "implements", "field_type", "parameter_type", "return_type", "instantiates"]));
    expect(report.facts.find((fact) => fact.kind === "extends")).toMatchObject({
      source: { name: "Consumer", scope: "repository" }, target: { name: "Base", scope: "repository" }, direct: true,
      evidence: { file: "src/relations.ts" },
    });
    expect(report.facts).toContainEqual(expect.objectContaining({
      kind: "field_type",
      source: expect.objectContaining({ name: "Consumer" }),
      target: expect.objectContaining({ name: "Dependency", scope: "repository" }),
    }));
    expect(report.facts.some((fact) => fact.target.name === "ReadonlyArray")).toBe(false);

    rmSync(cwd, { recursive: true, force: true });
  });

  it("does not fabricate an empty graph when TypeScript project semantics are unavailable", () => {
    const cwd = join(tmpdir(), `openarch-semantic-relations-no-config-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    expect(semanticEvidenceView(collectTypeScriptSemanticRelations(cwd))).toMatchObject({
      availability: "unavailable",
      coverage: { symbols: "unavailable", relations: "unavailable" },
      facts: [],
    });
    rmSync(cwd, { recursive: true, force: true });
  });
});
