/**
 * 跨文件断言包装解析（2026-08-12 调研落地）：测试文件 import 的 helper 模块中，
 * 导出的函数体内含精确断言 → 该函数是断言包装；测试体调用它即视为有断言。
 *
 * 性能方案（定向惰性解析 + 结果缓存）：
 * - 只解析"测试文件实际 import 且位于项目内"的目标文件（跳过 node_modules 包
 *   与生产模块），不扫描全部文件；
 * - 结果按目标文件缓存（command-scoped Map），同一 helper 被 N 个测试 import
 *   只 parse 一次——实际新增 parse 量 = 唯一 helper 文件数（典型 <50），
 *   相对现有"每测试文件 4-8 次 query"仅 +6% 量级。
 *
 * 边界（第一版不做，保持漏报方向安全）：重导出（helper re-export 第三方）、
 * 别名 import（`import { x as y }`）、动态 import。这些场景的测试维持原判定。
 */

import { Effect } from "effect";
import type { QueryCapture, QueryMatch, ParserService } from "../port/ParserService";
import { absolutePathKey } from "../infra/paths";

/** 提取文件内"导出函数 → 体内含精确断言"的包装集合。 */
export interface CrossFileAssertionScope {
  /** 目标文件 → 断言包装函数名集合（该文件导出的函数体内含断言）。 */
  readonly wrapperNamesByFile: ReadonlyMap<string, ReadonlySet<string>>;
  /** 测试体内调用名是否为跨文件断言包装（engine 已按该测试文件的 import 目标聚合）。 */
  readonly isWrapperCall: (callee: string) => boolean;
}

const exportedFunctionPattern = `[
  (export_statement (function_declaration name: (identifier) @name body: (statement_block) @body) @fn)
  (export_statement (lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function) @body)) @fn)
]`;

const directAssertionPattern = `(call_expression function: (identifier) @callee) @call`;

/** Java：文件内任意方法（helper 类方法），体内含标准 JUnit 断言调用。 */
const javaMethodPattern = `(method_declaration name: (identifier) @name body: (block) @body) @method`;
const javaCallPattern = `(method_invocation name: (identifier) @name) @call`;

/** Python：文件级函数定义，体内含 assert 语句。 */
const pythonFunctionPattern = `(function_definition name: (identifier) @name body: (block) @body) @fn`;
const pythonAssertPattern = `(assert_statement) @assertion`;

const JAVA_ASSERTION_METHODS = new Set([
  "assertEquals", "assertNotEquals", "assertTrue", "assertFalse", "assertNull", "assertNotNull",
  "assertSame", "assertNotSame", "assertThrows", "assertThat", "assertArrayEquals",
  "assertDoesNotThrow", "assertIterableEquals", "fail",
]);

export type CrossFileLanguage = "ts" | "java" | "python";

/** 从目标文件提取断言包装导出函数名（语法级：体内含精确断言）。
 *  用 startIndex/endIndex（0-based 字节偏移）判定归属——各 adapter 的行号
 *  对多行函数体只报声明行，行号判定会漏。 */
export const collectWrapperExports = async (
  parser: ParserService,
  targetPath: string,
  language: CrossFileLanguage = "ts",
): Promise<ReadonlySet<string>> => {
  if (language === "java") return collectJavaWrapperExports(parser, targetPath);
  if (language === "python") return collectPythonWrapperExports(parser, targetPath);
  const functions = await Effect.runPromise(parser.query(targetPath, exportedFunctionPattern));
  const calls = await Effect.runPromise(parser.query(targetPath, directAssertionPattern));
  const directCalls = calls.flatMap((match) => {
    const callee = capture(match, "callee")?.text;
    const call = capture(match, "call");
    return callee !== undefined && call?.startIndex !== undefined && call.endIndex !== undefined
      && (callee === "expect" || callee === "assert") ? [{ start: call.startIndex, end: call.endIndex }] : [];
  });
  return wrapperNamesFrom(functions, directCalls);
};

const collectJavaWrapperExports = async (parser: ParserService, targetPath: string): Promise<ReadonlySet<string>> => {
  const methods = await Effect.runPromise(parser.query(targetPath, javaMethodPattern));
  const calls = await Effect.runPromise(parser.query(targetPath, javaCallPattern));
  const directCalls = calls.flatMap((match) => {
    const name = capture(match, "name")?.text;
    const call = capture(match, "call");
    return name !== undefined && call?.startIndex !== undefined && call.endIndex !== undefined
      && JAVA_ASSERTION_METHODS.has(name) ? [{ start: call.startIndex, end: call.endIndex }] : [];
  });
  return wrapperNamesFrom(methods, directCalls);
};

const collectPythonWrapperExports = async (parser: ParserService, targetPath: string): Promise<ReadonlySet<string>> => {
  const functions = await Effect.runPromise(parser.query(targetPath, pythonFunctionPattern));
  const asserts = await Effect.runPromise(parser.query(targetPath, pythonAssertPattern));
  const assertRanges = asserts.flatMap((match) => {
    const assertion = capture(match, "assertion");
    return assertion?.startIndex !== undefined && assertion.endIndex !== undefined
      ? [{ start: assertion.startIndex, end: assertion.endIndex }] : [];
  });
  return wrapperNamesFrom(functions, assertRanges);
};

/** 从函数/方法查询中提取"体内含给定断言范围"的名字集合。 */
const wrapperNamesFrom = (
  matches: readonly import("../port/ParserService").QueryMatch[],
  directCalls: readonly { readonly start: number; readonly end: number }[],
): ReadonlySet<string> => {
  const wrapperNames = new Set<string>();
  for (const match of matches) {
    const name = capture(match, "name")?.text;
    const body = capture(match, "body");
    if (name === undefined || body === undefined) continue;
    const bodyStart = body.startIndex;
    const bodyEnd = body.endIndex;
    if (bodyStart !== undefined && bodyEnd !== undefined
      && directCalls.some((call) => call.start >= bodyStart && call.end <= bodyEnd)) {
      wrapperNames.add(name);
    }
  }
  return wrapperNames;
};

const capture = (match: QueryMatch, name: string): QueryCapture | undefined =>
  match.captures.find((item) => item.name === name);

/** 按目标文件扩展名推断跨文件提取语言；不支持的语法保持无跨文件包装结论。 */
const languageForPath = (path: string): CrossFileLanguage | undefined =>
  path.endsWith(".java") ? "java"
    : path.endsWith(".py") ? "python"
      : /\.(?:ts|tsx|js|jsx|mjs|cjs|vue)$/i.test(path) ? "ts"
        : undefined;

/** 构建跨文件作用域：对测试文件全部 import 目标惰性解析，聚合断言包装名。
 *  传入跨文件缓存（同一 helper 被多个测试 import 时只 parse 一次）。 */
export const resolveCrossFileAssertionScope = (
  parser: ParserService,
  testAstImports: readonly { readonly resolvedPath: string | null }[],
  productionPaths: ReadonlySet<string>,
  cache: Map<string, ReadonlySet<string>>,
): Promise<CrossFileAssertionScope> => {
  const byFile = new Map<string, ReadonlySet<string>>();
  const requestedTargets = new Set<string>();
  for (const ref of testAstImports) {
    if (ref.resolvedPath === null) continue;
    // 生产路径集合以绝对路径 key 存储；resolvedPath 也统一为同一 key 再比较，
    // 否则相对/绝对路径混用会让生产模块过滤恒为 false。
    const normalized = absolutePathKey(ref.resolvedPath);
    if (productionPaths.has(normalized)) continue; // 生产模块不是断言 helper
    if (!languageForPath(normalized)) continue; // Go/Rust 等无跨文件语法，保持漏报方向安全
    requestedTargets.add(normalized);
  }
  const promises = [...requestedTargets].map(async (target) => {
    let names = cache.get(target);
    if (names === undefined) {
      const language = languageForPath(target);
      names = language === undefined ? new Set<string>() : await collectWrapperExports(parser, target, language);
      cache.set(target, names);
    }
    byFile.set(target, names);
  });
  return Promise.all(promises).then(() => {
    const allNames = new Set<string>();
    for (const names of byFile.values()) for (const name of names) allNames.add(name);
    return {
      wrapperNamesByFile: byFile,
      isWrapperCall: (callee: string): boolean => allNames.has(callee),
    };
  });
};
