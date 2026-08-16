import { describe, expect, it } from "vitest";
import { debtDocument, debtDocumentPath } from "../../src/coordination/DebtTemplates";

describe("debtDocument", () => {
  it("builds a deferred service Debt with the durable contract shape", () => {
    const document = debtDocument({
      repositoryId: "repo-1", serviceId: "svc-a", debtId: "debt-1",
      title: "Defer parser split", reason: "No third-language evidence yet.",
      reconsiderCondition: "When a third language strategy lands.",
    });
    expect(document).toEqual({
      schemaVersion: "1",
      debt: { repositoryId: "repo-1", serviceId: "svc-a", debtId: "debt-1" },
      title: "Defer parser split",
      reason: "No third-language evidence yet.",
      reconsiderCondition: "When a third language strategy lands.",
      status: "deferred",
    });
    expect(debtDocumentPath(document)).toBe("debts/repo-1/svc-a/debt-1.json");
  });

  it("rejects path-like identities and invalid status", () => {
    expect(() => debtDocument({
      repositoryId: "repo/1", serviceId: "svc-a", debtId: "debt-1",
      title: "x", reason: "y", reconsiderCondition: "z",
    })).toThrow(/repositoryId/);
    expect(() => debtDocument({
      repositoryId: "repo-1", serviceId: "svc-a", debtId: "debt-1",
      title: "x", reason: "y", reconsiderCondition: "z", status: "open" as never,
    })).toThrow(/status/);
  });

  it("keeps optional acceptance criteria only when non-empty", () => {
    const withCriteria = debtDocument({
      repositoryId: "repo-1", serviceId: "svc-a", debtId: "debt-1",
      title: "x", reason: "y", reconsiderCondition: "z", acceptanceCriteria: "P95 stays below gate",
    });
    expect(withCriteria.acceptanceCriteria).toBe("P95 stays below gate");
    const withoutCriteria = debtDocument({
      repositoryId: "repo-1", serviceId: "svc-a", debtId: "debt-1",
      title: "x", reason: "y", reconsiderCondition: "z", acceptanceCriteria: "  ",
    });
    expect(withoutCriteria.acceptanceCriteria).toBeUndefined();
  });
});
