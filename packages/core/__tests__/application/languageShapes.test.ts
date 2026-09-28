import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseLanguageShapes, shapesFingerprintOf, shapesSourceOf } from "../../src/domain/languageShapes";
import { languageShapeErrorsText, projectShapesOfRead, readProjectShapes } from "../../src/application/projectShapes";
import { withTemporaryDirectory } from "../support/temporaryDirectory";

/**
 * 语言形状契约（2026-09-27 §6/Q1 覆盖 + §6/Q2 独立身份 + v1 只接线 weak_assertion_methods）。
 *
 * 这些用例锁住四件事：
 * 1. 未声明 ⇒ 空指纹 + `builtin`（现有项目零迁移的构造性保证）；
 * 2. 声明 ⇒ 非空指纹，且**确定性**（语言排序、类内名单排序、去重、与键书写顺序无关）；
 * 3. 未接线的形状类别（`assertion_methods` / `fixture_call_patterns`）⇒ `not_wired`；
 *    未知类别（`test_file_patterns`）⇒ `unknown_shape_class`（**永不会接线**，不能报成"本版未接线"）；
 * 4. 未接线的**语言键**（`python`/`go`/`rust`/错拼 `ts`）⇒ `not_wired`，同族别名（`javascript`/`vue`）
 *    给出"该写 `typescript`"的提示（2026-09-27 独立复验：接受它们只改身份不改判断，
 *    而报告仍打印"未声明 shapes"，是一句假陈述）；
 * 5. 类型错误（列表里混入空串/数字）⇒ 显式错误。
 */
const configOf = (shapes: unknown) => ({ status: "ok" as const, value: { shapes } });
const configPathIn = (directory: string): string => {
  mkdirSync(join(directory, ".openarch"), { recursive: true });
  return join(directory, ".openarch", "config.yml");
};

describe("languageShapes（域层纯权威）", () => {
  it("treats an absent or empty declaration as builtin with an empty fingerprint", () => {
    for (const value of [undefined, {}, { typescript: {} }]) {
      const parsed = parseLanguageShapes(value);
      expect(parsed.errors).toEqual([]);
      expect(shapesFingerprintOf(parsed.shapes)).toBe("");
      expect(shapesSourceOf(shapesFingerprintOf(parsed.shapes))).toBe("builtin");
    }
  });

  it("is deterministic: language order, in-class name order, duplicates — none of them move the fingerprint", () => {
    const left = parseLanguageShapes({
      typescript: { weak_assertion_methods: ["toBeTruthy", "toBeFalsy"] },
      java: { weak_assertion_methods: ["assertNotNull"] },
    });
    const right = parseLanguageShapes({
      java: { weak_assertion_methods: ["assertNotNull"] },
      typescript: { weak_assertion_methods: ["toBeFalsy", "toBeTruthy", "toBeTruthy"] },
    });
    expect(left.errors).toEqual([]);
    expect(right.errors).toEqual([]);
    const fingerprint = shapesFingerprintOf(left.shapes);
    expect(fingerprint).not.toBe("");
    expect(shapesFingerprintOf(right.shapes)).toBe(fingerprint);
    // 同一份声明两次求值也必须相同（"跨运行稳定"的最小可证形式）。
    expect(shapesFingerprintOf(parseLanguageShapes({
      java: { weak_assertion_methods: ["assertNotNull"] },
      typescript: { weak_assertion_methods: ["toBeTruthy", "toBeFalsy"] },
    }).shapes)).toBe(fingerprint);
    // 内容不同 ⇒ 指纹不同（否则身份就失去了判别力）。
    expect(shapesFingerprintOf(parseLanguageShapes({ typescript: { weak_assertion_methods: ["toBeTruthy"] } }).shapes)).not.toBe(fingerprint);
    expect(shapesSourceOf(fingerprint)).toBe("project");
  });

  it("rejects shape classes that are not wired in v1 instead of silently accepting them", () => {
    // 草案 §2 已命名但 v1 未接线的两类：声明它们会改身份（指纹）而不改判断 ⇒ 必须报错。
    for (const shapeClass of ["assertion_methods", "fixture_call_patterns"]) {
      const parsed = parseLanguageShapes({ java: { [shapeClass]: ["assertThat"] } });
      expect(parsed.shapes).toEqual({});
      expect(parsed.errors).toHaveLength(1);
      expect(parsed.errors[0]).toMatchObject({ path: `shapes.java.${shapeClass}`, kind: "not_wired" });
      expect(parsed.errors[0]!.message).toContain("not yet wired");
    }
    const unknown = parseLanguageShapes({ java: { test_file_patterns: ["**/*IT.java"] } });
    // `test_file_patterns` 是 Q3 明令不新增的类别：它**永不会**接线，因此不能与
    // `assertion_methods`（将来可能接线）共用 `not_wired`——那会让人等一个不会到来的版本。
    expect(unknown.errors[0]).toMatchObject({ path: "shapes.java.test_file_patterns", kind: "unknown_shape_class" });
    expect(unknown.errors[0]!.message).toContain("not a known shape class");
  });

  it("rejects language keys with no wired judgement instead of silently changing only the identity", () => {
    // 2026-09-27 独立复验（真实 CLI e2e）：声明 `shapes.python`/`shapes.ts` 曾 exit 0、写入非空
    // `shapesFingerprint`（身份变了、baseline 作废），而 `test --bloat` 仍打印
    // "内置默认（未声明 shapes）" —— 判断没变，报告里还多了一句与事实不符的陈述。
    for (const language of ["python", "go", "rust", "ts"]) {
      const parsed = parseLanguageShapes({ [language]: { weak_assertion_methods: ["x"] } });
      expect(parsed.shapes).toEqual({});
      expect(parsed.errors).toHaveLength(1);
      expect(parsed.errors[0]).toMatchObject({ path: `shapes.${language}`, kind: "not_wired" });
      expect(parsed.errors[0]!.message).toContain("java, typescript");
      expect(shapesFingerprintOf(parsed.shapes)).toBe("");
    }
    // 同族但键名不同：拒绝之外必须给出"该写哪个键"，否则用户只看到一句拒绝（JS/Vue 项目的真实陷阱）。
    for (const alias of ["javascript", "vue"]) {
      const parsed = parseLanguageShapes({ [alias]: { weak_assertion_methods: ["x"] } });
      expect(parsed.errors[0]).toMatchObject({ path: `shapes.${alias}`, kind: "not_wired" });
      expect(parsed.errors[0]!.message).toContain("declared as `typescript`");
    }
    // 白名单内的两个键仍然生效（拒绝没有扩大化）。
    expect(parseLanguageShapes({ java: { weak_assertion_methods: ["assertNotNull"] } }).errors).toEqual([]);
  });

  it("rejects malformed declarations (wrong container, wrong element types, bad language ids)", () => {
    expect(parseLanguageShapes(["typescript"]).errors).toEqual([
      { path: "shapes", kind: "invalid_value", message: "shapes must be a mapping of language to language shapes" },
    ]);
    expect(parseLanguageShapes({ typescript: ["toBeTruthy"] }).errors[0]).toMatchObject({ path: "shapes.typescript", kind: "invalid_value" });
    expect(parseLanguageShapes({ typescript: { weak_assertion_methods: "toBeTruthy" } }).errors[0])
      .toMatchObject({ path: "shapes.typescript.weak_assertion_methods", kind: "invalid_value" });
    expect(parseLanguageShapes({ typescript: { weak_assertion_methods: ["toBeTruthy", ""] } }).errors[0])
      .toMatchObject({ path: "shapes.typescript.weak_assertion_methods", kind: "invalid_value" });
    expect(parseLanguageShapes({ "Type Script": { weak_assertion_methods: ["toBeTruthy"] } }).errors[0])
      .toMatchObject({ path: "shapes.Type Script", kind: "invalid_language_key" });
  });
});

describe("projectShapes（读取唯一入口，经 readProjectConfig）", () => {
  it("reads a declaration through the config file and reports source=project", () => withTemporaryDirectory("shapes-read", async (dir) => {
    const path = configPathIn(dir);
    writeFileSync(path, "languages: [typescript]\nshapes:\n  typescript:\n    weak_assertion_methods: [toBeTruthy, toBeFalsy]\n");
    const read = readProjectShapes(path);
    expect(read.errors).toEqual([]);
    expect(read.source).toBe("project");
    expect(read.byLanguage.typescript?.weakAssertionMethods).toEqual(["toBeTruthy", "toBeFalsy"]);
    expect(read.fingerprint).toBe("typescript:weak_assertion_methods:toBeFalsy,toBeTruthy");
  }));

  it("a missing config file is not an error: builtin, empty fingerprint (zero migration)", () => withTemporaryDirectory("shapes-missing", async (dir) => {
    const read = readProjectShapes(join(dir, ".openarch", "config.yml"));
    expect(read).toEqual({ byLanguage: {}, fingerprint: "", source: "builtin", errors: [] });
  }));

  it("surfaces an unsupported class as an error to the caller (never as 'not declared')", () => {
    const read = projectShapesOfRead(configOf({ java: { assertion_methods: ["assertThat"] } }) as never);
    expect(read.source).toBe("builtin");
    expect(read.byLanguage).toEqual({});
    expect(read.errors).toHaveLength(1);
    expect(languageShapeErrorsText(read.errors)).toContain("shapes.java.assertion_methods");
  });

  it("does not accept a partially valid declaration as either declared or undeclared", () => {
    // java 合法、typescript 用了未接线类别 ⇒ 整份声明不可用：不得只用 java 那半份去判断。
    const read = projectShapesOfRead(configOf({
      java: { weak_assertion_methods: ["assertNotNull"] },
      typescript: { assertion_methods: ["expect"] },
    }) as never);
    expect(read.errors).toHaveLength(1);
    expect(languageShapeErrorsText(read.errors)).toContain("not yet wired");
  });
});
