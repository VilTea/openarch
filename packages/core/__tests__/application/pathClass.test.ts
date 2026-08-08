import { describe, it, expect } from "vitest";
import { classifyPath, parsePathClasses, layerWeightOf } from "../../src/application/pathClass";

describe("parsePathClasses", () => {
  it("解析 config paths + 自动补 default", () => {
    const cfg = {
      paths: {
        domain: { pattern: "**/domain/**", weight: 1.3 },
        parser: { pattern: "**/rule/**" },
      },
    };
    const c = parsePathClasses(cfg);
    expect(c.length).toBe(3); // domain + parser + default
    expect(c.find(p => p.name === "domain")!.weight).toBe(1.3);
    expect(c.find(p => p.name === "parser")!.weight).toBeUndefined(); // 未设 = 缺省 1.0
    expect(c.find(p => p.name === "default")!.pattern).toBe("**");
  });

  it("空 paths → 仅 default", () => {
    expect(parsePathClasses({})).toEqual([{ pattern: "**", name: "default" }]);
    expect(parsePathClasses({ paths: {} })).toHaveLength(1);
  });

  it("已有 default 不重复补", () => {
    const c = parsePathClasses({ paths: { default: { pattern: "**" } } });
    expect(c).toHaveLength(1);
    expect(c[0].name).toBe("default");
  });

  it("keeps parser precedence while classifying CLI command orchestration", () => {
    const classes = parsePathClasses({
      paths: {
        parser: { pattern: "**/adapter/{rule,parser}/**" },
        adapter: { pattern: "packages/core/src/adapter/**" },
        application: { pattern: "{packages/core/src/application/**,packages/cli/src/commands/**}" },
        default: { pattern: "**" },
      },
    });
    expect(classifyPath("packages/core/src/adapter/parser/TsStrategy.ts", classes)).toBe("parser");
    expect(classifyPath("packages/core/src/adapter/storage/JsonFileStorage.ts", classes)).toBe("adapter");
    expect(classifyPath("packages/cli/src/commands/diff.ts", classes)).toBe("application");
  });
});

describe("layerWeightOf", () => {
  const classes = [
    { pattern: "**/domain/**", name: "domain", weight: 1.3 },
    { pattern: "**/rule/**", name: "parser", weight: 0.8 },
    { pattern: "**", name: "default" },
  ];

  it("路径匹配 → 返回对应 weight", () => {
    expect(layerWeightOf("packages/core/src/domain/alpha.ts", classes)).toBe(1.3);
    expect(layerWeightOf("packages/core/src/adapter/rule/CelAdapter.ts", classes)).toBe(0.8);
  });

  it("无 weight → 缺省 1.0", () => {
    expect(layerWeightOf("packages/cli/bin/openarch.js", classes)).toBe(1.0);
  });

  it("Windows 绝对路径 → classifyPath normalize 后正确分类", () => {
    expect(layerWeightOf("E:\\workspace\\openarch\\packages\\core\\src\\domain\\alpha.ts", classes)).toBe(1.3);
    expect(layerWeightOf("E:\\workspace\\openarch\\packages\\core\\src\\adapter\\rule\\CelAdapter.ts", classes)).toBe(0.8);
  });
});
