import { describe, expect, it } from "vitest";
import { FACT_DOMAINS, SCRIPT_FACT_CAPABILITIES } from "../../src/script-runtime/projectFacts";
import { SCRIPT_AST_FACTS } from "../../src/staged-analysis/types";

const descriptors = [
  ...SCRIPT_FACT_CAPABILITIES.map((fact) => ({ ...fact })),
  ...SCRIPT_AST_FACTS.map((fact) => ({ ...fact })),
];

describe("script fact registry", () => {
  it("is a complete self-describing authority with unique ids", () => {
    const ids = new Set(descriptors.map((fact) => fact.id));
    expect(ids.size).toBe(descriptors.length);
    expect(descriptors.length).toBe(9);
    for (const fact of descriptors) {
      expect(fact.kind, fact.id).toMatch(/^(requires|ast)$/);
      expect(FACT_DOMAINS.includes(fact.domain as (typeof FACT_DOMAINS)[number]), `${fact.id}: unknown domain ${fact.domain}`).toBe(true);
      expect(["current", "experimental", "deprecated"].includes(fact.status), `${fact.id}: unknown status`).toBe(true);
      expect(fact.summaryId.startsWith("scriptFact."), fact.id).toBe(true);
      expect(fact.usageId.startsWith("scriptFact."), fact.id).toBe(true);
      expect(fact.outputs.length, `${fact.id}: outputs must not be empty`).toBeGreaterThan(0);
      if (fact.builtinConsumers) {
        expect(fact.builtinConsumers.length, `${fact.id}: builtinConsumers must not be empty`).toBeGreaterThan(0);
        for (const consumer of fact.builtinConsumers) expect(consumer.trim().length, `${fact.id}: builtin consumer id`).toBeGreaterThan(0);
      }
      if (fact.lifecycle) expect(fact.lifecycle.trim().length, `${fact.id}: lifecycle must not be empty`).toBeGreaterThan(0);
      if (fact.aliases) {
        expect(fact.aliases.length, `${fact.id}: aliases must not be empty`).toBeGreaterThan(0);
        for (const alias of fact.aliases) expect(alias).not.toBe(fact.id);
      }
    }
  });

  it("explains every fact without a built-in or script consumer", () => {
    const byId = Object.fromEntries(descriptors.map((fact) => [fact.id, fact]));
    expect(byId["change-surface.v1"].builtinConsumers).toContain("engine:staged-analysis");
    for (const id of ["structure-metrics.v1", "invocation-bindings.v1", "semantic-relations.v1"]) {
      expect(byId[id].lifecycle, `${id} must carry a lifecycle/retirement reason`).toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });

  it("keeps every registered fact resolvable from ProjectFacts or an AST fact stage", () => {
    expect(SCRIPT_FACT_CAPABILITIES.some((fact) => fact.id === "file-classification.v1")).toBe(true);
    expect(SCRIPT_AST_FACTS.some((fact) => fact.id === "static-imports.v1")).toBe(true);
    const stringKey = SCRIPT_AST_FACTS.find((fact) => fact.id === "string-key-calls-ts-js.v1");
    expect(stringKey?.aliases).toContain("string-key-calls.v1");
  });
});
