import { describe, expect, it } from "vitest";
import { orphanedBaselinePaths } from "../../src/application/baselineReconciliation";

describe("baseline reconciliation", () => {
  it("selects only baseline entries whose source no longer exists", () => {
    expect(orphanedBaselinePaths([
      ["packages/core/src/application/diff.ts", {}],
      ["packages/core/src/domain/removed-during-refactor.ts", {}],
    ], (path) => path.endsWith("diff.ts"))).toEqual(["packages/core/src/domain/removed-during-refactor.ts"]);
  });
});
