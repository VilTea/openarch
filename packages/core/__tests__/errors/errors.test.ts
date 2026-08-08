import { describe, it, expect } from "vitest";
import { ParseError, NoGitError } from "../../src/errors/errors";

describe("TaggedError", () => {
  it("ParseError 带 path + cause", () => {
    const e = new ParseError({ path: "a.ts", cause: new Error("boom") });
    expect(e._tag).toBe("ParseError");
    expect(e.path).toBe("a.ts");
  });
  it("NoGitError 带 cwd", () => {
    const e = new NoGitError({ cwd: "/tmp" });
    expect(e._tag).toBe("NoGitError");
    expect(e.cwd).toBe("/tmp");
  });
});
