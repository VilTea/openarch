// packages/cli/src/exit-code.ts
// design v5.2 §5.3 退出码映射（错误 _tag → exit code）
// Step 1A 仅处理 ParseError/BaselineSchemaError/IoError；Block/Cel/Lock 类属 Step 2 预留

/**
 * 把 TaggedError 的 _tag 映射到 CLI 退出码。
 *
 * 本函数只负责**错误**那一半：未识别的错误一律 fail-closed 到 `3`（因此配置类错误
 * ——如 `GateConfigurationError`——与解析/IO/schema 失败同为 `3`，不会退化成别的码）。
 * 裁决那一半（`PASS`/`WARN`/`BLOCK` → `0`/`1`/`2`）在 gate / test / anti-patterns 命令里产生。
 *
 * | exit | 含义                                                                    |
 * |------|-------------------------------------------------------------------------|
 * | 0    | PASS / 无待调查信号 / hook 降级（LockTimeout，Step 2）                   |
 * | 1    | WARN（已声明策略触发）、配置审计 drift、review/diff 的待解释事实          |
 * | 2    | BLOCK（已声明策略强制）                                                  |
 * | 3    | **事实不可用或配置/环境错误**：`UNAVAILABLE`（baseline 缺失、范围/形状身份不兼容、配置不可用）与 parse/CEL/IO/schema 失败 |
 *
 * 该映射同时被发行版 Skill 的 `gate-response.md`（退出码一节）陈述；改动这里必须同步那一节。
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
