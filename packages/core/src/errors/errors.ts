// packages/core/src/errors/errors.ts
import { Data } from "effect";

/** AST 解析失败 → exit 3（design §5.3） */
export class ParseError extends Data.TaggedError("ParseError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

/** 无 git 仓库 → exit 3 */
export class NoGitError extends Data.TaggedError("NoGitError")<{
  readonly cwd: string;
}> {}

/** baseline.json schema 不合法 → exit 3 */
export class BaselineSchemaError extends Data.TaggedError("BaselineSchemaError")<{
  readonly path: string;
  readonly reason: string;
}> {}

/** 文件读写 IO 失败 → exit 3 */
export class IoError extends Data.TaggedError("IoError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}
