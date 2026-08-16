// packages/core/src/staged-analysis/stringKeyCalls.ts
// 引擎内置的声明式字符串键事实（string-key-calls-ts-js.v1，旧别名
// string-key-calls.v1）：把 DI/RPC/事件总线/HTTP 路由这类"字符串键跨文件
// 相关"的原始语法事实归一成 records，脚本只负责语义配对。引号、三元字符串
// 常量与局部字符串变量的解析由引擎负责；动态键保留为 dynamicCall，不猜测。
import type { QueryMatch } from "../port/ParserService";
import type { StageRecord } from "./types";

export const STRING_KEY_CALLS_QUERY = `[
  (call_expression
    function: (member_expression object: (identifier) @obj property: (property_identifier) @prop)
    arguments: (arguments (string) @key))
  (call_expression
    function: (member_expression object: (identifier) @obj property: (property_identifier) @prop)
    arguments: (arguments (identifier) @arg))
  (call_expression
    function: (member_expression object: (identifier) @obj property: (property_identifier) @prop)
    arguments: (arguments (object (pair key: (property_identifier) @pkey value: (string) @key))))
  (call_expression
    function: (identifier) @callee
    arguments: (arguments (identifier) @arg))
  (lexical_declaration
    (variable_declarator name: (identifier) @name value: (array (string) @arrayKey)))
  (lexical_declaration
    (variable_declarator name: (identifier) @name value: (string) @stringValue))
  (lexical_declaration
    (variable_declarator name: (identifier) @name
      value: (ternary_expression (string) @ternaryA (string) @ternaryB)))
]`;

const cleanQuotes = (text: string | undefined): string | undefined =>
  typeof text === "string" ? text.replace(/^["']|["']$/g, "") : text;

/** 文件扩展名是否在 string-key-calls-ts-js.v1 的 TS/JS 语法覆盖范围内。 */
export const supportsStringKeyCalls = (file: string): boolean =>
  /\.(?:[cm]?[jt]s|jsx|tsx)$/i.test(file);

type StringKeyCallRecord = Omit<StageRecord, "_file">;

export const stringKeyCallRecords = (matches: readonly QueryMatch[]): readonly StringKeyCallRecord[] =>
  matches.flatMap((match): StringKeyCallRecord[] => {
    const capture = (name: string): string | undefined =>
      match.captures.find((item) => item.name === name)?.text;
    const obj = capture("obj");
    const prop = capture("prop");
    const key = cleanQuotes(capture("key"));
    const pkey = capture("pkey");
    const name = capture("name");
    const arg = capture("arg");
    const callee = capture("callee");
    const arrayKey = cleanQuotes(capture("arrayKey"));
    const stringValue = cleanQuotes(capture("stringValue"));
    const ternaryA = cleanQuotes(capture("ternaryA"));
    const ternaryB = cleanQuotes(capture("ternaryB"));
    if (name && ternaryA !== undefined && ternaryB !== undefined) {
      return [
        { kind: "local", name, value: ternaryA },
        { kind: "local", name, value: ternaryB },
      ];
    }
    if (name && arrayKey !== undefined) return [{ kind: "array", name, key: arrayKey }];
    if (name && stringValue !== undefined) return [{ kind: "local", name, value: stringValue }];
    if (obj && prop && key !== undefined) return [{ kind: "call", op: `${obj}.${prop}`, pkey, key }];
    if (obj && prop && arg !== undefined) return [{ kind: "dynamicCall", op: `${obj}.${prop}`, arg }];
    if (callee && arg !== undefined) return [{ kind: "callArg", op: callee, arg }];
    return [];
  });
