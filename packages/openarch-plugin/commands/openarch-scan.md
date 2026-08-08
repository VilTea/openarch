---
name: openarch-scan
description: |
  运行 openarch scan 建立/更新基线。扫描范围由项目 config 的 languages 与文件角色决定。
---

## 流程

遵循实事求是约束：报告实际扫描范围、排除项和解析失败；不要把未扫描的文件当作“无风险”。

### Step 1: Scope check

确认 scan 范围——全部项目还是特定目录？如果用户没指定，默认全项目。

### Step 2: 跑 scan

```bash
openarch scan --report [glob...]
```

`--report` 在更新快照后直接显示当前结构复盘。它不表示改动前后的 D_MR；需要改动差值时，先对未暂存的工作树运行 `openarch check --worktree --report`，准备提交后再对 Git index 运行 `openarch check --staged --report`。

### Step 3: 状态报告

- **DONE**——N 文件已扫描，基线已更新
- **BLOCKED**——扫描失败（ParseError / 无文件匹配）
