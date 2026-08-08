// packages/core/src/adapter/parser/ParserFactory.ts
import { Effect, Layer } from "effect";
import { ParserService } from "../../port/ParserService";
import { ParseError } from "../../errors/errors";
import type { FileAst, Language } from "../../domain/ast";
import { parserStrategyForFile, supportedLanguageIds } from "./LanguageRegistry";

/** 工厂方法：按文件扩展名选 parse 策略（策略 + 工厂方法模式）。 */
const strategyForFile = parserStrategyForFile;

const unsupported = (path: string, operation: string) => {
  const ext = path.toLowerCase();
  return Effect.fail(new ParseError({ path, cause: new Error(`${operation} unsupported for extension: ${ext}`) }));
};

/** ParserService 的 Phase 1 实现（Layer） */
export const TreeSitterParserLive = Layer.effect(
  ParserService,
  Effect.gen(function* () {
    return {
      parse: (path: string): Effect.Effect<FileAst, ParseError> =>
        (strategyForFile(path)?.parse(path) ?? unsupported(path, "parse")).pipe(
          Effect.catchAll((e) =>
            Effect.fail(e instanceof ParseError ? e : new ParseError({ path, cause: e }))
          )
        ),
      parseText: (path: string, text: string): Effect.Effect<FileAst, ParseError> =>
        strategyForFile(path)?.parseText(path, text) ?? unsupported(path, "parse text"),
      query: (path: string, pattern: string) =>
        strategyForFile(path)?.query(path, pattern) ?? unsupported(path, "query"),
      invocationBindings: (path: string) =>
        strategyForFile(path)?.invocationBindings?.(path) ?? unsupported(path, "invocation bindings"),
      supportedLanguages: Effect.succeed<readonly Language[]>(supportedLanguageIds()),
    };
  })
);
