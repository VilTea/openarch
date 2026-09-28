// @ts-nocheck —— 插件包无独立 tsconfig，本文件以 vitest 转译运行。
//
// DSH 插件契约对齐测试：守住「我们注册的工具面被 DSH 0.1.5-rc.3 的现行契约接受」。
//
// 背景（2026-09-26 对 DSH 检出 0.1.5-rc.3 的实测，`@deepseek-ai/dsh-tools/lib/index.js`）：
// - `tools.register(definition)` 只校验 `output {schema, render}`、`timeoutMs` 与保留名
//   `run_code`；它**不编译、不校验 `parameters`**。所以 `{type:"object",properties:{…}}`
//   这种 JSON Schema 包壳能被注册成功——那是宿主对未知形状的宽容，不是合规：
//   模型仍能看到合法 schema，但 `defineTool`/`validateArgs` 与动态包的
//   `harness.defineTool` 都会以 `parameters.type must be a value schema object` 拒绝，
//   参数校验因此完全缺失。本用例把「注册形态」锁在 DSL 上，让这种隐性依赖重新显形。
// - `presentResult(args, result)` 的第二个参数是 `ToolResult = {content, isError, meta?}`；
//   verdict 走 `output.presentationMeta` 落在 `result.meta`，不是 `result` 本身。
// - `output.schema` 走 `assertSupportedJsonSchema`（另一条更宽的 raw 子集），
//   与参数面的 DSL 不是同一套规则。
//
// 机检一半（`describe.skipIf`）在能解析到本机 DSH 检出时，直接拿真实库复验；
// 解析不到就跳过并在名字里说明——离线/CI 下本用例不会假绿，只是不参与。
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectParameterSchema } from "../host/openarch-contract.mjs";
import { apply } from "../host/openarch-tools.mjs";

/** 本机 DSH 检出的 `@deepseek-ai/dsh-tools` 入口（相对 npm 全局根），仅供机检。 */
const DSH_TOOLS_ENTRY = join("@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-tools", "lib", "index.js");

/** 依次尝试：显式环境变量、npm 全局根。解析不到返回 null（用例跳过）。 */
function resolveDshToolsEntry() {
  const candidates = [];
  if (process.env.OPENARCH_DSH_TOOLS_ENTRY) candidates.push(process.env.OPENARCH_DSH_TOOLS_ENTRY);
  for (const prefix of [process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules") : null, "/usr/local/lib/node_modules", "/usr/lib/node_modules"]) {
    if (prefix) candidates.push(join(prefix, DSH_TOOLS_ENTRY));
  }
  try {
    const require = createRequire(import.meta.url);
    candidates.push(require.resolve("@deepseek-ai/dsh-tools"));
  } catch {
    // 本包不依赖 dsh-tools；解析失败是常态。
  }
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

const dshToolsEntry = resolveDshToolsEntry();
const loadDshTools = async () => (dshToolsEntry ? await import(dshToolsEntry) : null);

/** 注册六个模型的假 ctx（沿用 openarch-tools.test.ts 的接缝约定）。 */
function registerTools() {
  const registered = [];
  const ctx = {
    get: (key) => {
      if (key === "systemPrompt") return { section: () => () => {} };
      if (key === "webServer") return { register: () => () => {} };
      return undefined;
    },
    effect: () => {},
    tools: { register: (definition) => { registered.push(definition); return () => {}; } },
  };
  apply(ctx, { openarchBin: "openarch", stateTtlMs: 60_000 });
  return registered;
}

const TOOLS = registerTools();

/** DSL 允许的值类型（`@deepseek-ai/dsh-tools` `ValueSchemaSpec` 的 type 取值，外加 author-only `json`）。 */
const DSL_TYPES = new Set(["string", "number", "integer", "boolean", "null", "array", "object", "json"]);

/** 走一遍属性映射（含 `oneOf` 分支），收集违规。 */
function dslViolations(node, path, seen = new Set()) {
  const violations = [];
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    violations.push(`${path} must be a value schema object`);
    return violations;
  }
  if (seen.has(node)) {
    violations.push(`${path} is circular`);
    return violations;
  }
  seen.add(node);
  if (Array.isArray(node.oneOf)) {
    if (node.oneOf.length < 2) violations.push(`${path}.oneOf must contain at least two schemas`);
    const sibling = ["type", "properties", "additionalProperties", "items", "enum", "const"].filter((key) => key in node);
    if (sibling.length > 0) violations.push(`${path}.${sibling[0]} is not supported beside oneOf`);
    node.oneOf.forEach((branch, index) => violations.push(...dslViolations(branch, `${path}.oneOf[${index}]`, seen)));
    return violations;
  }
  if (!DSL_TYPES.has(node.type)) violations.push(`${path}.type must be one of ${[...DSL_TYPES].join("/")}`);
  if ("required" in node && node.required !== true) violations.push(`${path}.required must be true when present`);
  if (node.type === "object" && typeof node.additionalProperties !== "boolean") {
    violations.push(`${path}.additionalProperties must be explicitly true or false`);
  }
  if (node.type === "array" && "items" in node) violations.push(...dslViolations(node.items, `${path}.items`, seen));
  if (node.type === "object" && node.properties) {
    for (const [key, child] of Object.entries(node.properties)) {
      violations.push(...dslViolations(child, `${path}.properties.${key}`, seen));
    }
  }
  return violations;
}

describe("DSH 契约对齐：工具注册形态（离线可跑）", () => {
  it("六个工具的参数都是 ParameterSchemaSpec 属性映射，不是 JSON Schema 包壳", () => {
    expect(TOOLS).toHaveLength(6);
    for (const tool of TOOLS) {
      // 属性映射本身不是 schema 节点：逐属性校验，不把映射当成一个节点。
      const perProperty = Object.entries(tool.parameters).flatMap(([key, node]) => dslViolations(node, `${tool.name}.parameters.${key}`));
      expect(perProperty, tool.name).toEqual([]);
      expect(tool.parameters.type, `${tool.name} 参数根不应带 type（包壳形态）`).toBeUndefined();
      expect(tool.parameters.properties, `${tool.name} 参数根不应带 properties（包壳形态）`).toBeUndefined();
      expect(Object.keys(tool.parameters).length, `${tool.name} 参数名不得叫 type/properties`).toBe(
        Object.keys(tool.parameters).filter((key) => key !== "type" && key !== "properties").length,
      );
    }
  });

  it("参数映射投影回模型侧 wire 形状后是开放对象根（模型的可见面不因注册形态改变）", () => {
    for (const tool of TOOLS) {
      const wire = projectParameterSchema({ type: "object", properties: tool.parameters });
      expect(wire.type, tool.name).toBe("object");
      expect(typeof wire.properties, tool.name).toBe("object");
      // 开放根：DSH 编译属性映射时不落 additionalProperties:false。
      expect("additionalProperties" in wire, tool.name).toBe(false);
      for (const [key, node] of Object.entries(wire.properties)) {
        expect(typeof node.type, `${tool.name}.${key} 投影后必须保留自己的 type`).toBe("string");
        expect("required" in node, `${tool.name}.${key} required 由包壳 required 数组承载`).toBe(false);
      }
      // 可 JSON 化（DSH 在 register 里做 lossless JSON 快照）。
      expect(JSON.parse(JSON.stringify(tool.parameters)), tool.name).toEqual(tool.parameters);
    }
  });

  it("参数包壳→DSL→wire 往返自洽：required 数组被搬到属性上再搬回来", () => {
    const wrapper = { type: "object", required: ["a"], properties: { a: { type: "boolean" }, b: { type: "string", title: "B" } } };
    const map = { a: { type: "boolean", required: true }, b: { type: "string", title: "B" } };
    // 1) 包壳 → 属性映射：required 数组搬到属性上（`parameterPropertyMap`），
    //    由注册面 assertion 覆盖；这里断言投影后的 wire 保持 required 语义。
    expect(projectParameterSchema(wrapper)).toEqual({
      type: "object",
      properties: { a: { type: "boolean" }, b: { type: "string", title: "B" } },
      required: ["a"],
    });
    // 2) 属性映射 → wire：`required:true` 搬回根上的 required 数组（DSH 编译属性映射的同一规则）。
    expect(projectParameterSchema({ type: "object", properties: map })).toEqual({
      type: "object",
      properties: { a: { type: "boolean" }, b: { type: "string", title: "B" } },
      required: ["a"],
    });
    // 3) 两者等价 ⇒ 注册形态换掉后模型侧 wire 不变。
    expect(projectParameterSchema({ type: "object", properties: map })).toEqual(projectParameterSchema(wrapper));
  });

  it("presentResult 消费 ToolResult({content,isError,meta})，verdict 走 meta", () => {
    const gate = TOOLS.find((tool) => tool.name === "openarch_check");
    const withMeta = gate.presentResult({}, { content: [], isError: false, meta: { verdict: "BLOCK", exitCode: 2 } });
    expect(withMeta).toEqual({ card: "generic", title: "OpenArch check：BLOCK（exit 2）" });
    const failed = gate.presentResult({}, { content: [{ type: "text", text: "boom" }], isError: true });
    expect(failed).toEqual({ card: "generic", title: "OpenArch check：ERROR" });
    const plain = gate.presentResult({}, { content: [], isError: false });
    expect(plain).toEqual({ card: "generic", title: "OpenArch check 结果" });
  });
});

describe.skipIf(dshToolsEntry === null)(`DSH 契约对齐：本机 DSH 检出机检（${dshToolsEntry ?? "未解析到"}）`, () => {
  it("真实库接受我们的参数与输出 schema，并真的做参数校验", async () => {
    const { assertSupportedJsonSchema, parameterSchemaSpecToJsonSchema, validateArgs } = await loadDshTools();
    for (const tool of TOOLS) {
      // 参数面：现行 DSL 必须能编译（`defineTool` / 动态 `harness.defineTool` 的前置）。
      expect(() => parameterSchemaSpecToJsonSchema(tool.parameters), tool.name).not.toThrow();
      // 输出面：register() 会跑的断言必须通过。
      expect(() => assertSupportedJsonSchema(tool.output.schema), tool.name).not.toThrow();
      // 投影结果 = 我们声明的 wire 形状。
      expect(parameterSchemaSpecToJsonSchema(tool.parameters)).toEqual(projectParameterSchema({ type: "object", properties: tool.parameters }));
      // 类型错的参数必须被判违规（旧包壳形态在这里直接抛 UNSUPPORTED_SCHEMA）。
      const wrong = Object.fromEntries(Object.keys(tool.parameters).map((key) => [key, "wrong-type"]));
      if (Object.keys(wrong).length > 0) {
        expect(validateArgs(tool.parameters, wrong).length, tool.name).toBeGreaterThan(0);
      }
    }
  });

  it("旧包壳形态在真实库上确实不被接受（记录我们迁移掉的那种隐性依赖）", async () => {
    const { parameterSchemaSpecToJsonSchema } = await loadDshTools();
    expect(() => parameterSchemaSpecToJsonSchema({ type: "object", properties: { worktree: { type: "boolean" } } })).toThrow(/value schema object/);
  });
});
