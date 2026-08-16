import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { Language, Node, Parser, Query } from "web-tree-sitter";
import { ParseError } from "../../errors/errors";
import type { QueryMatch } from "../../port/ParserService";
import { runtimeResourcePath, treeSitterRuntimePath } from "../../runtimeAssets";
import { createParseTreeCache } from "./TreeCache";
import { createQueryResultCache } from "./QueryResultCache";

export interface ParsedTreeSource {
  readonly code: string;
  readonly root: Node;
}

// web-tree-sitter owns one process-global WASM module. Concurrent Parser.init
// calls can race in Web-compatible runtimes, so cache the in-flight operation.
let treeSitterInitialization: Promise<void> | undefined;

const initializeTreeSitter = (): Promise<void> => {
  if (!treeSitterInitialization) {
    treeSitterInitialization = Parser.init({ locateFile: () => treeSitterRuntimePath() }).catch((cause) => {
      treeSitterInitialization = undefined;
      throw cause;
    });
  }
  return treeSitterInitialization;
};

/**
 * One lazily initialized parser per grammar. Language strategies own grammar
 * semantics; this runtime owns only the shared Tree-sitter lifecycle.
 */
export const createTreeSitterRuntime = (grammarFile: string) => {
  let parser: Parser | null = null;
  let language: Language | null = null;
  let initialization: Promise<Parser> | undefined;
  const queryCache = new Map<string, Query>();
  // 同一命令内，同一路径会被多个 provider/规则反复 query；解析树缓存按
  // 「路径 + 内容 SHA-256」寻址，内容变化必然换 key，不会返回过期 AST。
  const treeCache = createParseTreeCache(128);
  // 跨进程 query 结果缓存。命中时无需初始化 WASM parser；grammar 文件内容
  // 哈希进入 key，grammar 不可读时整个缓存禁用，避免跨 grammar 污染。
  const resultCache = createQueryResultCache();
  let grammarKey: string | undefined;

  const cacheKeyFor = (code: string, pattern: string): string | undefined => {
    if (grammarKey === undefined) {
      try {
        grammarKey = createHash("sha256").update(readFileSync(grammarPath())).digest("hex");
      } catch {
        return undefined;
      }
    }
    return resultCache.keyFor(code, pattern, grammarKey);
  };

  const grammarPath = (): string => runtimeResourcePath("grammars", grammarFile);

  const ensureParser = () =>
    Effect.gen(function* () {
      if (parser && language) return parser;
      return yield* Effect.tryPromise({
        try: async () => {
          if (!initialization) {
            initialization = (async () => {
              await initializeTreeSitter();
              // Load bytes ourselves so grammar loading is independent of host
              // runtime detection (Node, Bun, or a future executable host).
              language = await Language.load(readFileSync(grammarPath()));
              parser = new Parser();
              parser.setLanguage(language);
              return parser;
            })().catch((cause) => {
              initialization = undefined;
              throw cause;
            });
          }
          return initialization;
        },
        catch: (cause) => new ParseError({ path: "(tree-sitter init)", cause }),
      });
    });

  const parseText = (filePath: string, code: string) =>
    Effect.gen(function* () {
      const activeParser = yield* ensureParser();
      try {
        return { code, root: treeCache.rootFor(activeParser, filePath, code) } satisfies ParsedTreeSource;
      } catch (cause) {
        return yield* Effect.fail(new ParseError({ path: filePath, cause: cause instanceof Error ? cause : new Error(String(cause)) }));
      }
    });

  const parse = (filePath: string) => parseText(filePath, readFileSync(filePath, "utf8"));

  const query = (filePath: string, pattern: string) => queryText(filePath, readFileSync(filePath, "utf8"), pattern);

  const queryText = (filePath: string, code: string, pattern: string) =>
    Effect.gen(function* () {
      const cacheKey = cacheKeyFor(code, pattern);
      if (cacheKey !== undefined) {
        const cached = resultCache.get(cacheKey);
        if (cached !== undefined) return cached;
      }
      const activeParser = yield* ensureParser();
      let root: Node;
      try {
        root = treeCache.rootFor(activeParser, filePath, code);
      } catch (cause) {
        return yield* Effect.fail(new ParseError({ path: filePath, cause: cause instanceof Error ? cause : new Error(String(cause)) }));
      }
      let compiled = queryCache.get(pattern);
      if (!compiled) {
        try {
          compiled = new Query(language!, pattern);
        } catch (cause) {
          return yield* Effect.fail(new ParseError({ path: filePath, cause: new Error(`invalid query: ${String(cause)}`) }));
        }
        queryCache.set(pattern, compiled);
      }
      const matches = compiled.matches(root).map((match) => ({
        captures: match.captures.map((capture) => ({
          name: capture.name,
          text: capture.node.text,
          startLine: capture.node.startPosition.row + 1,
          endLine: capture.node.endPosition.row + 1,
          startIndex: capture.node.startIndex,
          endIndex: capture.node.endIndex,
        })),
      })) satisfies QueryMatch[];
      if (cacheKey !== undefined) resultCache.put(cacheKey, matches);
      return matches;
    });

  return { parse, parseText, query, queryText };
};
