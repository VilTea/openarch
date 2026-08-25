// @ts-nocheck —— 插件包无独立 tsconfig，本文件以 vitest 转译运行。
// 该文件是 schema 的防漂移测试：JSON Schema 文件、示例清单、DEFAULTS 与
// 真实 GovernanceState 产出必须互相同步。内置一个只支持本仓库 schema
// 关键字的轻量校验器（生产插件本身不依赖 ajv）。
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { collectGovernanceState, DEFAULTS } from "../host/openarch-state.mjs";

const dshRoot = fileURLToPath(new URL("../", import.meta.url));
const schemaDir = join(dshRoot, "schema");
const manifestPath = join(dshRoot, "examples", "dsh-plugin.manifest.json");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const pluginSchema = readJson(join(schemaDir, "dsh-plugin.schema.json"));
const configSchema = readJson(join(schemaDir, "dsh-config.schema.json"));
const stateSchema = readJson(join(schemaDir, "dsh-state.schema.json"));
const manifest = readJson(manifestPath);

const SCHEMA_FILES = {
  "dsh-plugin.schema.json": pluginSchema,
  "dsh-config.schema.json": configSchema,
  "dsh-state.schema.json": stateSchema,
};

const UNSUPPORTED_KEYS = ["not", "allOf", "if", "then", "else", "contains", "prefixItems", "minProperties", "maxProperties", "dependentRequired"];

const matchesType = (value, type) => {
  switch (type) {
    case "null": return value === null;
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number";
    default: throw new Error(`unsupported type in schema: ${type}`);
  }
};

const resolvePointer = (pointer, root) => {
  const parts = pointer.slice(2).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node = root;
  for (const part of parts) {
    if (node === null || typeof node !== "object" || !(part in node)) {
      throw new Error(`$ref 目标不存在: ${pointer}`);
    }
    node = node[part];
  }
  return node;
};

const collectRefs = (schema, acc = []) => {
  if (Array.isArray(schema)) {
    for (const item of schema) collectRefs(item, acc);
    return acc;
  }
  if (schema === null || typeof schema !== "object") return acc;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref" && typeof value === "string") acc.push(value);
    else collectRefs(value, acc);
  }
  return acc;
};

const checkSchemaNode = (instance, schema, roots, path, errors) => {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${path}: schema false`);
    return;
  }
  if (schema === null || typeof schema !== "object") throw new Error(`非法 schema 节点 @${path}`);

  if (typeof schema.$ref === "string") {
    const [file, pointer = ""] = schema.$ref.split("#");
    if (file) {
      const external = roots.external[file];
      const target = pointer ? resolvePointer(`#${pointer}`, external) : external;
      checkSchemaNode(instance, target, { root: external, external: roots.external }, path, errors);
    } else {
      checkSchemaNode(instance, resolvePointer(`#${pointer}`, roots.root), roots, path, errors);
    }
    return;
  }

  for (const key of UNSUPPORTED_KEYS) {
    if (key in schema) throw new Error(`schema 使用了测试校验器不支持的关键字 ${key}`);
  }

  if ("type" in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(instance, type))) {
      errors.push(`${path}: 期望类型 ${types.join("|")}，实际 ${instance === null ? "null" : typeof instance}`);
    }
  }
  if ("enum" in schema && !schema.enum.some((item) => isDeepStrictEqual(item, instance))) {
    errors.push(`${path}: 不在枚举中`);
  }
  if ("const" in schema && !isDeepStrictEqual(schema.const, instance)) {
    errors.push(`${path}: 不等于 const`);
  }
  if (typeof instance === "string") {
    if ("minLength" in schema && instance.length < schema.minLength) errors.push(`${path}: 字符串过短`);
    if ("maxLength" in schema && instance.length > schema.maxLength) errors.push(`${path}: 字符串过长`);
    if ("pattern" in schema && !new RegExp(schema.pattern).test(instance)) errors.push(`${path}: 不匹配 pattern ${schema.pattern}`);
  }
  if (typeof instance === "number") {
    if ("minimum" in schema && instance < schema.minimum) errors.push(`${path}: 小于 minimum`);
    if ("maximum" in schema && instance > schema.maximum) errors.push(`${path}: 大于 maximum`);
  }
  if (Array.isArray(instance)) {
    if ("minItems" in schema && instance.length < schema.minItems) errors.push(`${path}: 数组过短`);
    if ("maxItems" in schema && instance.length > schema.maxItems) errors.push(`${path}: 数组过长`);
    if ("items" in schema) {
      instance.forEach((item, index) => checkSchemaNode(item, schema.items, roots, `${path}[${index}]`, errors));
    }
    if (schema.uniqueItems === true) {
      for (let i = 0; i < instance.length; i += 1) {
        for (let j = i + 1; j < instance.length; j += 1) {
          if (isDeepStrictEqual(instance[i], instance[j])) {
            errors.push(`${path}: 存在重复项 [${i}]=[${j}]`);
            return;
          }
        }
      }
    }
  }
  if (instance !== null && typeof instance === "object" && !Array.isArray(instance)) {
    if ("required" in schema) {
      for (const required of schema.required) {
        if (!(required in instance)) errors.push(`${path}: 缺少必填字段 ${required}`);
      }
    }
    if ("properties" in schema) {
      for (const [key, value] of Object.entries(instance)) {
        if (key in schema.properties) {
          checkSchemaNode(value, schema.properties[key], roots, `${path}.${key}`, errors);
        } else if (schema.additionalProperties === false) {
          errors.push(`${path}.${key}: 不允许的额外字段`);
        } else if (typeof schema.additionalProperties === "object") {
          checkSchemaNode(value, schema.additionalProperties, roots, `${path}.${key}`, errors);
        }
      }
    }
  }
  for (const keyword of ["oneOf", "anyOf"]) {
    if (keyword in schema) {
      const outcomes = schema[keyword].map((subschema) => {
        const branchErrors = [];
        checkSchemaNode(instance, subschema, roots, path, branchErrors);
        return branchErrors;
      });
      const matches = outcomes.filter((branchErrors) => branchErrors.length === 0).length;
      if ((keyword === "oneOf" && matches !== 1) || (keyword === "anyOf" && matches === 0)) {
        errors.push(`${path}: ${keyword} 匹配 ${matches} 个分支（要求 ${keyword === "oneOf" ? "恰好 1" : "至少 1"}）`);
      }
    }
  }
};

const errorsOf = (instance, schema, external = {}) => {
  const errors = [];
  checkSchemaNode(instance, schema, { root: schema, external }, "$", errors);
  return errors;
};

const assertValid = (instance, schema, external = {}) => {
  const errors = errorsOf(instance, schema, external);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
};

const fakeExec = (stdout) => async () => ({ stdout, stderr: "" });
const freshTmpDir = () => mkdtempSync(join(tmpdir(), "openarch-schema-"));

describe("openarch-schemas: JSON Schema 文件", () => {
  it("三个 schema 均可解析、带 draft $schema 与唯一 $id", () => {
    const ids = new Set();
    for (const [file, schema] of Object.entries(SCHEMA_FILES)) {
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(typeof schema.$id, file).toBe("string");
      expect(schema.$id.startsWith("https://openarch.dev/schemas/"), file).toBe(true);
      expect(typeof schema.title, file).toBe("string");
      expect(ids.has(schema.$id), file).toBe(false);
      ids.add(schema.$id);
    }
  });

  it("所有 $ref 目标可解析（本地 pointer + 外部 schema 文件都存在）", () => {
    for (const [file, schema] of Object.entries(SCHEMA_FILES)) {
      for (const ref of collectRefs(schema)) {
        const [external, pointer = ""] = ref.split("#");
        if (external) {
          expect(existsSync(join(schemaDir, external)), `${file} -> ${ref}`).toBe(true);
          const targetSchema = readJson(join(schemaDir, external));
          if (pointer) resolvePointer(`#${pointer}`, targetSchema);
        } else {
          resolvePointer(`#${pointer}`, schema);
        }
      }
    }
  });
});

describe("openarch-schemas: 示例插件清单", () => {
  it("示例清单通过 dsh-plugin schema，且 entry 文件真实存在", () => {
    assertValid(manifest, pluginSchema, { "dsh-config.schema.json": configSchema });
    for (const module of manifest.modules) {
      expect(existsSync(join(dshRoot, module.entry)), module.entry).toBe(true);
    }
  });

  it("清单工具面与 openarch-tools 实际注册面一致", () => {
    expect(manifest.tools.map((tool) => tool.name).sort()).toEqual([
      "openarch_check",
      "openarch_context",
      "openarch_contract",
      "openarch_review",
      "openarch_scan",
      "openarch_test",
    ]);
    expect(manifest.slots.map((slot) => `${slot.slot}:${slot.id}`).sort()).toEqual([
      "conversation.composer.dock:openarch-governance",
      "shell.overlay:openarch-dashboard",
    ]);
  });

  it("清单里每个模块的 config 都通过 config schema", () => {
    for (const module of manifest.modules) {
      if (module.config) expect(() => assertValid(module.config, configSchema)).not.toThrow();
    }
  });
});

describe("openarch-schemas: 配置契约", () => {
  it("config schema 的属性集与 DEFAULTS + cwd/refreshMs 完全同步", () => {
    const expected = new Set([...Object.keys(DEFAULTS), "cwd", "refreshMs"]);
    const actual = new Set(Object.keys(configSchema.properties));
    expect(actual).toEqual(expected);
  });

  it("合法配置通过，未知键被 additionalProperties: false 拦截", () => {
    expect(errorsOf({ ...DEFAULTS, cwd: "C:\\work", refreshMs: 20_000 }, configSchema)).toEqual([]);
    expect(errorsOf({ stateTtlMs: 60_000, unknownKey: true }, configSchema).length).toBeGreaterThan(0);
  });
});

describe("openarch-schemas: GovernanceState 契约", () => {
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const cannedContext = JSON.stringify({
    configuration: "available",
    schema: "context-json-v1",
    baseline: { available: true, files: 593, scope: "compatible", freshness: "stale", scanAt: "2026-08-11T21:03:20.936Z" },
    architecturePolicy: { state: "configured", declaredRules: 14 },
    changes: { worktree: { paths: 1, sourcePaths: 1 }, staged: { paths: 0, sourcePaths: 0 } },
  });

  it.skipIf(process.env.OPENARCH_TEST_SCOPE !== "integration")("已初始化仓库的真实状态快照通过 state schema", async () => {
    const state = await collectGovernanceState({
      ...DEFAULTS,
      cwd: repoRoot,
      execFileAsync: fakeExec(cannedContext),
    });
    expect(state.initialized).toBe(true);
    // 校验线上契约：先 JSON 序列化（丢弃 undefined、NaN→null），再对 schema 校验。
    assertValid(JSON.parse(JSON.stringify(state)), stateSchema);
  });

  it("未初始化目录的 fail-closed 快照通过 state schema", async () => {
    const state = await collectGovernanceState({ ...DEFAULTS, cwd: freshTmpDir(), execFileAsync: fakeExec("{}") });
    expect(state.initialized).toBe(false);
    assertValid(state, stateSchema);
  });

  it("state schema 的初始化分支与生产字段集同步", () => {
    const branches = stateSchema.oneOf;
    expect(branches[0].properties.initialized.const).toBe(false);
    expect(branches[1].properties.initialized.const).toBe(true);
    expect(Object.keys(branches[1].properties).sort()).toEqual([
      "baseline",
      "cli",
      "collectedAt",
      "config",
      "contractCatalog",
      "distribution",
      "history",
      "initialized",
      "root",
      "scanStatus",
      "testGovernance",
      "top",
    ]);
  });
});
