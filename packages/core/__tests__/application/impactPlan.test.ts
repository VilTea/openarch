import { describe, expect, it } from "vitest";
import { buildImpactPlan, symbolUseDemandForProfiles } from "../../src/application/impactPlan";
import { toAbsolute } from "../../src/infra/paths";

describe("buildImpactPlan", () => {
  it("turns a public contract into direct-consumer verification actions", () => {
    const plan = buildImpactPlan([{
      file: "src/api.ts",
      changes: [{ anchor: "Api", kind: "interface_add_remove" }],
    }], new Map([[toAbsolute("src/api.ts"), [toAbsolute("src/client.ts")]]]));

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      file: "src/api.ts",
      publicContracts: ["Api (interface_add_remove)"],
      directConsumers: ["src/client.ts"],
      symbolConsumers: [],
    });
    expect(plan[0].actions).toContainEqual({ kind: "verify_direct_consumers", consumers: ["src/client.ts"] });
  });

  it("does not emit guidance for implementation-only changes", () => {
    expect(buildImpactPlan([{
      file: "src/internal.ts",
      changes: [{ anchor: "compact", kind: "function_body" }],
    }], new Map())).toEqual([]);
  });

  it("turns changed declarations into a bounded symbol-use demand", () => {
    expect(symbolUseDemandForProfiles([{
      file: "src/api.ts",
      changes: [
        { anchor: "Api.publish", kind: "public_method_sig" },
        { anchor: "import:./internal", kind: "dependency_add" },
      ],
    }, {
      file: "src/notes.ts",
      changes: [{ anchor: "file", kind: "comment_whitespace" }],
    }])).toEqual({ declarations: [{ file: "src/api.ts", names: ["publish"] }] });
  });

  it("keeps LSP direct references beside static file consumers without changing the plan's static edge", () => {
    const plan = buildImpactPlan([{
      file: "src/api.rs",
      changes: [{ anchor: "publish", kind: "public_method_sig" }],
    }], new Map([[toAbsolute("src/api.rs"), [toAbsolute("src/lib.rs")]]]), [{
      origin: { language: "rust", providerId: "rust-analyzer-symbol-use", evidenceSource: "lsp" },
      state: { availability: "partial", coverage: { declarations: "complete", repositoryReferences: "partial" }, reason: "Cargo workspace manifests are outside the calibrated single-crate symbol-use scope" },
      facts: [{ language: "rust", declaration: { file: "src/api.rs", name: "publish", kind: "function", line: 3 }, publicSurface: "declared-public", repositoryReferences: [{ file: "src/client.rs", line: 8 }] }],
    }]);

    expect(plan[0]).toMatchObject({
      directConsumers: ["src/lib.rs"],
      symbolConsumers: [{
        symbol: "publish", consumers: ["src/client.rs"], repositoryReferencesCoverage: "partial",
        staticImportConsumers: ["src/lib.rs"], sharedConsumers: [], staticOnlyConsumers: ["src/lib.rs"], symbolOnlyConsumers: ["src/client.rs"],
      }],
    });
  });

  it("excludes the changed file's own internal references from symbol consumers", () => {
    const plan = buildImpactPlan([{
      file: "src/api.ts",
      changes: [{ anchor: "Api.publish", kind: "public_method_sig" }],
    }], new Map(), [{
      origin: { language: "typescript", providerId: "typescript-symbol-use", evidenceSource: "compiler" },
      state: { availability: "partial", coverage: { declarations: "complete", repositoryReferences: "partial" }, reason: "demand-driven" },
      facts: [{
        language: "typescript",
        declaration: { file: "src/api.ts", name: "publish", kind: "method", line: 3 },
        publicSurface: "declared-public",
        repositoryReferences: [
          { file: "src/api.ts", line: 10 },
          { file: "src/client.ts", line: 8 },
        ],
      }],
    }]);

    expect(plan[0].symbolConsumers[0].consumers).toEqual(["src/client.ts"]);
  });
});
