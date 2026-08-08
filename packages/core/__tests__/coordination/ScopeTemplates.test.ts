import { describe, expect, it } from "vitest";
import { repositoryDocument, serviceDocument, productDocument, scopeDocumentPath, validateScopeIdentity } from "../../src/coordination/ScopeTemplates";

describe("validateScopeIdentity", () => {
  it("accepts ASCII identifiers with . _ : @ -", () => {
    expect(validateScopeIdentity("repo-a.1_2:3@4-5")).toBeUndefined();
  });
  it("rejects path separators and whitespace", () => {
    expect(validateScopeIdentity("a/b")).toBe("identifier contains an unsupported character");
    expect(validateScopeIdentity("a b")).toBe("identifier contains an unsupported character");
  });
  it("rejects empty and overlong", () => {
    expect(validateScopeIdentity("")).toBeDefined();
    expect(validateScopeIdentity("a".repeat(129))).toBeDefined();
  });
});

describe("repositoryDocument / serviceDocument / productDocument", () => {
  it("builds repository document mirroring the service contract", () => {
    expect(repositoryDocument("repo-1")).toEqual({ schemaVersion: "1", repository: { repositoryId: "repo-1" } });
  });
  it("builds service document bound to parent repository", () => {
    expect(serviceDocument("repo-1", "svc-a")).toEqual({ schemaVersion: "1", service: { repositoryId: "repo-1", serviceId: "svc-a" } });
  });
  it("builds product document rejecting duplicate services", () => {
    expect(() => productDocument("prod-1", ["repo-1/svc-a", "repo-1/svc-a"])).toThrow(/more than once/);
  });
  it("builds product document with distinct services", () => {
    expect(productDocument("prod-1", ["repo-1/svc-a", "repo-2/svc-a"])).toEqual({
      schemaVersion: "1",
      product: { productId: "prod-1", services: [{ repositoryId: "repo-1", serviceId: "svc-a" }, { repositoryId: "repo-2", serviceId: "svc-a" }] },
    });
  });
  it("rejects product with no services", () => {
    expect(() => productDocument("prod-1", [])).toThrow(/at least one service/);
  });
});

describe("scopeDocumentPath", () => {
  it("mirrors the service document path layout", () => {
    expect(scopeDocumentPath(repositoryDocument("repo-1"))).toBe("repositories/repo-1/scope.json");
    expect(scopeDocumentPath(serviceDocument("repo-1", "svc-a"))).toBe("services/repo-1/svc-a/scope.json");
    expect(scopeDocumentPath(productDocument("prod-1", ["repo-1/svc-a"]))).toBe("products/prod-1/scope.json");
  });
});
