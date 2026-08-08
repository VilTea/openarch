# Go 工具链配置

Go 符号使用需要 `gopls` 与 `go`。先运行 `openarch toolchains` 调查，再在用户级配置中填写缺失项：

```yaml
version: 1
tools:
  gopls:
    executable: "<gopls 的绝对路径>"
  go:
    executable: "<go 的绝对路径>"
```

重跑 `openarch toolchains`，两项均为 `AVAILABLE` 才满足 provider 前置。随后对未暂存改动运行 `openarch check --worktree --semantic --report`，确认报告实际显示 `go-gopls-symbol-use` 及其 coverage；工具可发现不等于 server 已就绪。单 `go.mod`、无 `go.work`/构建约束/生成源码且全部已打开受治理源码均已发布诊断，才是已校准的完整引用范围；缺诊断或配置成功都不自动扩大该事实边界。准备提交时仍运行不带 `--semantic` 的 `openarch check --staged --report`。
