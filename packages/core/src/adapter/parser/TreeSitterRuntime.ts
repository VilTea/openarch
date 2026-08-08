import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { Language, Node, Parser, Query } from "web-tree-sitter";
import { ParseError } from "../../errors/errors";
import type { QueryMatch } from "../../port/ParserService";
import { runtimeResourcePath, treeSitterRuntimePath } from "../../runtimeAssets";

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
      const tree = activeParser.parse(code);
      if (!tree) {
        return yield* Effect.fail(new ParseError({ path: filePath, cause: new Error("tree-sitter parse returned null") }));
      }
      return { code, root: tree.rootNode } satisfies ParsedTreeSource;
    });

  const parse = (filePath: string) => parseText(filePath, readFileSync(filePath, "utf8"));

  const query = (filePath: string, pattern: string) =>
    Effect.gen(function* () {
      const activeParser = yield* ensureParser();
      const code = readFileSync(filePath, "utf8");
      const tree = activeParser.parse(code);
      if (!tree) {
        return yield* Effect.fail(new ParseError({ path: filePath, cause: new Error("tree-sitter parse returned null") }));
      }
      let compiled: Query;
      try {
        compiled = new Query(language!, pattern);
      } catch (cause) {
        return yield* Effect.fail(new ParseError({ path: filePath, cause: new Error(`invalid query: ${String(cause)}`) }));
      }
      return compiled.matches(tree.rootNode).map((match) => ({
        captures: match.captures.map((capture) => ({
          name: capture.name,
          text: capture.node.text,
          startLine: capture.node.startPosition.row + 1,
          endLine: capture.node.endPosition.row + 1,
          startIndex: capture.node.startIndex,
          endIndex: capture.node.endIndex,
        })),
      })) satisfies QueryMatch[];
    });

  return { parse, parseText, query };
};
