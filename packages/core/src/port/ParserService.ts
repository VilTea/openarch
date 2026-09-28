// packages/core/src/port/ParserService.ts
import { Context, Effect } from "effect";
import type { FileAst, Language } from "../domain/ast";
import type { InvocationBindingFact } from "../domain/invocationBindings";
import { ParseError } from "../errors/errors";

/** tree-sitter query 捕获项（简化：name + 命中文本，不暴露原始 TreeNode） */
export interface QueryCapture {
  readonly name: string;   // 捕获名，如 @event → "event"
  readonly text: string;   // 命中节点的源码文本，如 "orders"
  /** 1-based 行号，供 provider 将断言/Mock 归属到测试体；旧 adapter 可缺省。 */
  readonly startLine?: number;
  readonly endLine?: number;
  /** 0-based source offsets. Providers use ranges rather than lines when ownership must exclude nested bodies. */
  readonly startIndex?: number;
  readonly endIndex?: number;
}

/** tree-sitter query 单次匹配（一组捕获） */
export interface QueryMatch {
  readonly captures: readonly QueryCapture[];
}

/** Port：文件 AST 解析（策略 + 工厂方法模式） */
export interface ParserService {
  /** 解析单个文件为 FileAst */
  readonly parse: (path: string) => Effect.Effect<FileAst, ParseError>;
  /** Parses bounded historical or editor text without writing a temporary file. */
  readonly parseText: (path: string, text: string) => Effect.Effect<FileAst, ParseError>;
  /** tree-sitter query（S-expression 模式匹配）。仅 discover 隐式依赖时用，热路径（scan/diff）不调 */
  readonly query: (path: string, pattern: string) => Effect.Effect<QueryMatch[], ParseError>;
  /**
   * 对**调用方已经持有**的文本做 tree-sitter query，不再读盘。
   *
   * 存在理由：调用方（LSP symbol-use、契约判定）已把源码读进内存，而 `query(path, pattern)`
   * 会重新 `readFileSync`；同一文件被读两次只是路径实现的副作用，不是语义要求。
   *
   * 缺省语义（fail-closed，刻意设计）：`queryText` 缺省**不等于**"查询结果为空"。
   * 缺省时调用方必须回退到重新读盘的 `query(path, pattern)`（该路径会按"路径 + 内容
   * SHA-256"命中解析树缓存），或者把该文件标记为不可判定；禁止把缺省当成空结果，
   * 那会把"无法判定"静默降级为"没有风险"。
   */
  readonly queryText?: (path: string, text: string, pattern: string) => Effect.Effect<QueryMatch[], ParseError>;
  /** Optional language-semantic capability; unsupported strategies stay unavailable. */
  readonly invocationBindings?: (path: string) => Effect.Effect<readonly InvocationBindingFact[], ParseError>;
  /** 当前 adapter 支持的语言列表 */
  readonly supportedLanguages: Effect.Effect<readonly Language[]>;
}

/** Effect Service Tag（六边形 port 定义） */
export const ParserService = Context.GenericTag<"ParserService", ParserService>("ParserService");
