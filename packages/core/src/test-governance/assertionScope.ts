/**
 * 语法级断言作用域识别（校准 2026-08-12 体验反馈，替代脆弱的前缀命名匹配）。
 *
 * 方案：同一文件内定义的命名函数（function_declaration / 具名 arrow
 * function），其函数体内若含精确断言调用（expect / assert），则该函数是
 * "断言包装函数"——测试体调用它即视为存在断言。这是纯语法（AST 结构）
 * 的作用域解析，不依赖函数命名惯例，helper 叫任意名字都能识别。
 *
 * 跨文件 helper（import 自其他模块）不在单文件 provider 范围内：collect
 * 只接收一个文件。跨文件场景由 rust provider 的"委托调用视为验证意图"
 * 同类语义处理，或后续扩展 provider 读取 import 源文件。
 */

export interface AssertionWrapperScope {
  /** 函数名 → 该函数体内精确断言调用行号集合（非空 = 断言包装函数）。 */
  readonly wrappers: ReadonlyMap<string, readonly number[]>;
  /** 判定：callee 是精确断言，或同文件内已定义的断言包装函数。 */
  readonly isAssertionCall: (callee: string) => boolean;
  /** 直接断言调用行号（精确 expect/assert，不含包装函数）。 */
  readonly directAssertionLines: readonly number[];
}

interface NamedFunction {
  readonly name: string;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

/** 从命名函数查询结果构建作用域。functions 来自函数名+体的 pattern；directLines 是精确断言调用行。 */
export const assertionWrapperScope = (
  functions: readonly NamedFunction[],
  directLines: readonly number[],
): AssertionWrapperScope => {
  const wrappers = new Map<string, readonly number[]>();
  for (const fn of functions) {
    const inside = directLines.filter((line) => line >= fn.bodyStart && line <= fn.bodyEnd);
    if (inside.length > 0) wrappers.set(fn.name, inside);
  }
  const isAssertionCall = (callee: string): boolean =>
    callee === "expect" || callee === "assert" || wrappers.has(callee);
  return { wrappers, isAssertionCall, directAssertionLines: directLines };
};

/** 从 QueryMatch 提取命名函数（name 捕获 + body 行号范围）。 */
export const namedFunctionsFrom = (
  matches: readonly { readonly name?: string; readonly bodyStart?: number; readonly bodyEnd?: number }[],
): readonly NamedFunction[] =>
  matches.flatMap((match) =>
    match.name !== undefined && match.bodyStart !== undefined && match.bodyEnd !== undefined
      ? [{ name: match.name, bodyStart: match.bodyStart, bodyEnd: match.bodyEnd }]
      : []);
