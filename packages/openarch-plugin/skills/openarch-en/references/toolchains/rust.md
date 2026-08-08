# Rust Toolchain Configuration

Rust symbol use needs `rust-analyzer` and `cargo`. After `openarch toolchains`, configure them in the user file:

```yaml
version: 1
tools:
  rust-analyzer:
    executable: "<absolute path to rust-analyzer>"
  cargo:
    executable: "<absolute path to cargo>"
```

This proves executable discovery only. Then run `openarch check --worktree --semantic --report` for unstaged work and confirm that it reports `rust-analyzer-symbol-use` with coverage; executable discovery does not prove server readiness. A single-root `Cargo.toml` crate without `build.rs`, a workspace, macro invocation, or conditional compilation can provide complete references after Rust Analyzer publishes diagnostics for every governed source. Missing diagnostics or any excluded shape remains `PARTIAL`. Use `openarch check --staged --report` without `--semantic` before committing.
