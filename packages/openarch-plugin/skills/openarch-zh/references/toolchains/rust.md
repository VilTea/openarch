# Rust 工具链配置

Rust 符号使用需要 `rust-analyzer` 与 `cargo`。运行 `openarch toolchains` 后，可在用户级配置填入：

```yaml
version: 1
tools:
  rust-analyzer:
    executable: "<rust-analyzer 的绝对路径>"
  cargo:
    executable: "<cargo 的绝对路径>"
```

配置项只说明可执行文件可发现。随后对未暂存改动运行 `openarch check --worktree --semantic --report`，确认报告实际显示 `rust-analyzer-symbol-use` 及其 coverage；工具可发现不等于 server 已就绪。单根 `Cargo.toml` 包在无 `build.rs`、工作区、宏调用或条件编译时，Rust Analyzer 为全部受治理源码发布诊断后可交付完整引用；缺通知或遇到任一排除形态仍为 `PARTIAL`。准备提交时仍运行不带 `--semantic` 的 `openarch check --staged --report`；不要用配置成功替代真实 provider 取证。
