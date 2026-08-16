/**
 * OpenArch DSH 插件 — JSON 契约面（Host）。
 *
 * 把 dsh/schema/ 下的 JSON Schema 变成运行时可用的契约：
 * - loadConfigContract()：读取 dsh-config.schema.json 的顶层允许键集
 *   （additionalProperties: false 的 properties 键），供各模块做配置白名单校验。
 * - strictConfig(config)：白名单之外的键 warn 并丢弃（fail-closed-lite：
 *   不因拼写错误的配置键静默生效，也不因 schema 文件缺失而阻断启动）。
 *
 * 读取失败（文件缺失/损坏）回退到 DEFAULTS 的键集并 warn——契约是护栏，
 * 不是启动前置。动态 Cordis 包（无文件系统）不经过本模块；schema 契约
 * 面向仓库静态模块与预设挂载。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "./openarch-state.mjs";

const schemaUrl = new URL("../schema/dsh-config.schema.json", import.meta.url);

let cachedKeys = null;
let cacheError = null;

/** 顶层允许键集（从 schema properties 推导；读失败回退 DEFAULTS 键）。 */
export function configKeys() {
  if (cachedKeys !== null) return cachedKeys;
  try {
    const schema = JSON.parse(readFileSync(fileURLToPath(schemaUrl), "utf8"));
    const properties = schema && typeof schema === "object" ? schema.properties : null;
    if (properties && typeof properties === "object") {
      cachedKeys = new Set(Object.keys(properties));
      return cachedKeys;
    }
    throw new Error("schema.properties 缺失或不是对象");
  } catch (error) {
    cacheError = String(error && error.message ? error.message : error);
    cachedKeys = new Set(Object.keys(DEFAULTS));
    return cachedKeys;
  }
}

/** schema 文件读取失败的原因（成功为 null）。 */
export function configContractError() {
  configKeys();
  return cacheError;
}

/**
 * 白名单校验：未知键 console.warn 并丢弃，返回干净对象。
 * 键值类型不做运行时校验（清单/预设作者负责；类型契约由测试覆盖）。
 */
export function strictConfig(config) {
  if (config === undefined || config === null) return {};
  if (typeof config !== "object") {
    console.warn("[openarch-dsh] config 必须是对象；已忽略:", typeof config);
    return {};
  }
  const allowed = configKeys();
  const clean = {};
  for (const [key, value] of Object.entries(config)) {
    if (allowed.has(key)) {
      clean[key] = value;
    } else {
      console.warn(`[openarch-dsh] 未知配置键 "${key}" 已忽略（契约见 dsh/schema/dsh-config.schema.json）`);
    }
  }
  return clean;
}
