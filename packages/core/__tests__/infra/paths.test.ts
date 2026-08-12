import { describe, it, expect } from "vitest";
import { toAbsolute, toRelative, projectRoot, absolutePathKey, toPosixPath } from "../../src/infra/paths";

describe("absolutePathKey (A1 回归：Windows 盘符大小写统一)", () => {
  it("盘符大小写不同 → 同一 key（Windows 上 inDegree 查表 miss 的根因）", () => {
    const upper = absolutePathKey("E:/repo/src/a.ts", ".");
    const lower = absolutePathKey("e:/repo/src/a.ts", ".");
    expect(upper).toBe(lower);
  });

  it("反斜杠输入 → 归一为同一 key", () => {
    const backslash = absolutePathKey("E:\\repo\\src\\a.ts", ".");
    const forward = absolutePathKey("E:/repo/src/a.ts", ".");
    expect(backslash).toBe(forward);
  });

  it("与 graph 节点 key 同源：resolvedPath 经 absolutePathKey 后必在图中命中", () => {
    const node = absolutePathKey("src/a.ts", "E:/repo");
    const resolved = absolutePathKey("E:/repo/src/a.ts", ".");
    expect(resolved).toBe(node);
  });
});

describe("toPosixPath", () => {
  it("纯分隔符转换：\\ → /，不解析 ..", () => {
    expect(toPosixPath("a\\b\\c.ts")).toBe("a/b/c.ts");
    expect(toPosixPath("a/../b")).toBe("a/../b");  // 不解析 ..（语义保持）
  });
});

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
