# Python 工具链配置

Python 符号使用需要外部 `pyright` 语言服务器。先运行 `openarch toolchains` 调查，不要仅因 Python 解释器或项目 `.venv` 存在就宣称可用。

用户级配置位于 `openarch toolchains` 输出的 `用户配置`。填写：

```yaml
version: 1
tools:
  pyright:
    executable: "<pyright-langserver 的绝对路径>"
```

随后重跑 `openarch toolchains`，确认 `pyright` 显示 `AVAILABLE [user-config]`，再对未暂存改动运行 `openarch check --worktree --semantic --report`，确认报告实际显示 `python-pyright-symbol-use` 及其 coverage。项目 `.venv`、`node_modules` 内的可执行文件仍被拒绝；动态导入、导入钩子等边界仍保持 `PARTIAL` 或 `UNAVAILABLE`。准备提交时仍运行不带 `--semantic` 的 `openarch check --staged --report`。
