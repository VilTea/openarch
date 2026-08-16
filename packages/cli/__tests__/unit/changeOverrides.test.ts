import { describe, expect, it } from "vitest";
import { missingOverridesMessage, parseChangeOverrides } from "../../src/semanticProfiles";

describe("file-scoped semantic overrides", () => {
  it("parses repeated overrides without conflating them with a global change type", () => {
    const overrides = parseChangeOverrides([
      "--change-override", "packages/cli/bin/openarch.js=dependency_add",
      "--change-override", "src\\legacy.js=function_body",
    ]);
    expect([...overrides!]).toEqual([
      ["packages/cli/bin/openarch.js", "dependency_add"],
      ["src/legacy.js", "function_body"],
    ]);
  });

  it("normalizes natural add/remove shorthand to the audited paired change kinds", () => {
    const overrides = parseChangeOverrides([
      "--change-override", "src/model.py=class_add",
      "--change-override", "src/schema.py=field_remove",
    ]);
    expect([...overrides!]).toEqual([
      ["src/model.py", "class_add_remove"],
      ["src/schema.py", "field_add_remove"],
    ]);
  });

  it("accepts an all-path batch override without treating it as a file path", () => {
    const overrides = parseChangeOverrides(["--change-override", "all=function_body"]);
    expect([...overrides!]).toEqual([["all", "function_body"]]);
  });

  it("renders all missing overrides as one retryable command", () => {
    expect(missingOverridesMessage("staged", [
      { path: "src/__init__.py", reason: "changed top-level syntax has no semantic classifier" },
      { path: "src/base.py", reason: "language parser does not provide declaration facts" },
    ])).toContain('--change-override "src/__init__.py=<actual-kind>" --change-override "src/base.py=<actual-kind>"');
  });
});
