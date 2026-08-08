import { describe, expect, it } from "vitest";
import { assessSymbolScopeImpactAdmission } from "../../src/domain/symbolScopeAdmission";

const requirements = (availability: "available" | "partial" | "unavailable") => [
  "before_declaration_identity", "after_declaration_identity", "repository_references", "public_surface", "common_population", "calibration_samples",
].map((id) => ({ id: id as Parameters<typeof assessSymbolScopeImpactAdmission>[0]["requirements"][number]["id"], availability }));

describe("symbol-scope impact admission", () => {
  it("admits only a complete versioned evidence set", () => {
    expect(assessSymbolScopeImpactAdmission({
      language: "typescript", providerId: "typescript-symbol-use", file: "src/api.ts", symbol: "publish",
      requirements: requirements("available"),
    })).toMatchObject({ availability: "available", eligible: true });
  });

  it("keeps incomplete formula prerequisites report-only", () => {
    const result = assessSymbolScopeImpactAdmission({
      language: "go", providerId: "go-gopls-symbol-use", file: "uuid.go", symbol: "Parse",
      requirements: [
        { id: "before_declaration_identity", availability: "unavailable", reason: "no before revision" },
        ...requirements("available").filter((requirement) => requirement.id !== "before_declaration_identity"),
      ],
    });
    expect(result).toMatchObject({ availability: "partial", eligible: false });
    expect(result.requirements[0]).toMatchObject({ availability: "unavailable" });
  });
});
