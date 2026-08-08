import { describe, it, expect } from "vitest";
import { toAbsolute, toRelative, projectRoot } from "../../src/infra/paths";

describe("toAbsolute", () => {
  it("相对路径 → 绝对路径，不含反斜杠（2026-07-08 bug 回归防御）", () => {
    const result = toAbsolute("packages/core/src/a.ts");
    expect(result).not.toContain("\\");    // normalize 到正斜杠——与 graph.ts map 对齐
    expect(result.startsWith(projectRoot().replace(/\\/g, "/"))).toBe(true);
  });

  it("已绝对路径 → 保持绝对，也 normalize 反斜杠", () => {
    const abs = `${projectRoot().replace(/\\/g, "/")}/packages/core/src/b.ts`;
    const result = toAbsolute(abs);
    expect(result).not.toContain("\\");
    expect(result).toBe(abs);
  });

  it("圆整——toRelative → toAbsolute（双射可逆）", () => {
    const abs = `${projectRoot().replace(/\\/g, "/")}/packages/core/src/c.ts`;
    const rel = toRelative(abs);
    expect(rel).not.toContain("\\");
    expect(toAbsolute(rel)).toBe(abs);
  });
});

describe("toRelative", () => {
  it("绝对路径 → 仓库相对，不含反斜杠", () => {
    const abs = `${projectRoot().replace(/\\/g, "/")}/packages/core/src/d.ts`;
    const rel = toRelative(abs);
    expect(rel).not.toContain("\\");
    expect(rel).toBe("packages/core/src/d.ts");
  });
});
