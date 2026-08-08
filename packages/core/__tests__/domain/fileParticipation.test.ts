import { describe, expect, it } from "vitest";
import { effectiveFileKind, participatesInPopulation } from "../../src/domain/fileParticipation";

describe("file participation", () => {
  it("keeps auxiliary artifacts observable without letting them join governed populations", () => {
    expect(participatesInPopulation("auxiliary", "observed")).toBe(true);
    expect(participatesInPopulation("auxiliary", "production-governance")).toBe(false);
    expect(participatesInPopulation("auxiliary", "test-governance")).toBe(false);
    expect(participatesInPopulation("auxiliary", "change-evidence")).toBe(false);
  });

  it("keeps tests in change evidence without treating them as production", () => {
    expect(participatesInPopulation("test", "change-evidence")).toBe(true);
    expect(participatesInPopulation("test", "production-governance")).toBe(false);
  });

  it("treats legacy baseline entries without a role as production", () => {
    expect(effectiveFileKind(undefined)).toBe("production");
    expect(participatesInPopulation(undefined, "production-governance")).toBe(true);
  });
});
