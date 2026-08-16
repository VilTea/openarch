import { describe, expect, it } from "vitest";
import { evaluateProtectedPaths, parseProtectedPathPolicy } from "../../src/application/protectedPaths";

describe("protected-path policy (authority_hygiene)", () => {
  const policy = parseProtectedPathPolicy({
    authority_hygiene: {
      protected_paths: [
        { pattern: "packages/core/src/port/**", level: "warn", reason: "port contracts need consumer verification", allow: ["packages/core/src/port/StorageService.ts"] },
        { pattern: "packages/core/src/domain/ast.ts", level: "block", reason: "core AST contract" },
      ],
    },
  });
  expect(policy.configured).toBe(true);
  expect(policy.errors).toEqual([]);

  it("warns on a directory subtree match", () => {
    expect(evaluateProtectedPaths(["packages/core/src/port/ParserService.ts"], policy)).toEqual({
      verdict: "WARN",
      triggered: [{ path: "packages/core/src/port/ParserService.ts", rule: policy.rules[0] }],
    });
  });

  it("blocks on an exact file match", () => {
    expect(evaluateProtectedPaths(["packages/core/src/domain/ast.ts"], policy).verdict).toBe("BLOCK");
  });

  it("passes unrelated paths", () => {
    expect(evaluateProtectedPaths(["packages/cli/src/main.ts"], policy)).toEqual({ verdict: "PASS", triggered: [] });
  });

  it("honors the recorded minimal allow-list exception", () => {
    expect(evaluateProtectedPaths(["packages/core/src/port/StorageService.ts"], policy)).toEqual({ verdict: "PASS", triggered: [] });
    expect(evaluateProtectedPaths(["packages/core/src/port/ParserService.ts"], policy).verdict).toBe("WARN");
  });

  it("surfaces invalid declarations instead of guessing", () => {
    const invalid = parseProtectedPathPolicy({
      authority_hygiene: { protected_paths: [{ pattern: "C:\\absolute", level: "warn", reason: "" }] },
    });
    expect(invalid.errors.length).toBeGreaterThan(0);
    expect(invalid.rules).toEqual([]);
  });
});
