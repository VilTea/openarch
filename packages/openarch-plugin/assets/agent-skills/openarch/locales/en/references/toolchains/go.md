# Go Toolchain Configuration

Go symbol use needs both `gopls` and `go`. Inspect first with `openarch toolchains`, then add missing tools to user configuration:

```yaml
version: 1
tools:
  gopls:
    executable: "<absolute path to gopls>"
  go:
    executable: "<absolute path to go>"
```

Both must be `AVAILABLE` before the provider can run. Then run `openarch check --worktree --semantic --report` for unstaged work and confirm that it reports `go-gopls-symbol-use` with coverage; executable discovery does not prove server readiness. Complete references remain calibrated only for a single `go.mod` module without `go.work`, build constraints, or generated Go source after diagnostics are published for every opened governed source. Use `openarch check --staged --report` without `--semantic` before committing.
