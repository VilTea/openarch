---
name: openarch-check
description: Run the unified OpenArch change verification workflow.
---

Use the OpenArch Skill selected for this session, then run:

```bash
openarch check --staged --report
```

`--staged --report` 同时输出本次改动的 D_MR/I_push 与策略报告；应在 scan 前运行。无 `--staged` 或文件参数的 `check --report` 不重新推断改动，仍会显示当前策略和 baseline 的存量 Top-3。Use `--tests` when test-governance evidence is needed. A WARN/BLOCK is evidence to investigate, never a reason to lower project rules.
