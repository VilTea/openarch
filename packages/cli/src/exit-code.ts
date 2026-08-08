// packages/cli/src/exit-code.ts
// design v5.2 §5.3 退出码映射（错误 _tag → exit code）
// Step 1A 仅处理 ParseError/BaselineSchemaError/IoError；Block/Cel/Lock 类属 Step 2 预留

/**
 * 把 TaggedError 的 _tag 映射到 CLI 退出码。
 *
 * | exit | 含义                                         |
 * |------|----------------------------------------------|
 * | 0    | PASS / hook 降级（LockTimeout，Step 2）      |
 * | 1    | WARN（--strict 升级，Step 2）                |
 * | 2    | BLOCK（Tier-1 红线，Step 2）                 |
 * | 3    | 内部错误（parse / CEL / IO / schema 失败）   |
 */
export const exitCodeFromError = (err: unknown): number => {
  if (err instanceof Error && err.name === "CoordinationError") return 3;
  const tag = (err as { _tag?: string })?._tag;
  switch (tag) {
    // Step 1A 错误
    case "ParseError":
      return 3;
    case "BaselineSchemaError":
      return 3;
    case "IoError":
      return 3;
    case "NoGitError":
      return 3;
    // Step 2 预留
    case "BlockRuleError":
      return 2;
    case "CelCompileError":
      return 3;
    case "LockTimeoutError":
      return 0; // hook 降级（eng review A3 决策）
    default:
      return 3;
  }
};
