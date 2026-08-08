---
name: openarch-context
description: Read OpenArch project facts so the Agent can reason about the current task without a fabricated workflow state.
---

Use the OpenArch Skill selected for this session, then run:

```bash
openarch context --json
```

`context` reports configuration, baseline, Git worktree/index change counts, pending evidence freshness and governance readiness. It does not recommend a unique next command or alter state. Combine its facts with the user's task:

- `BLOCK`/failed validation and explicit policy are hard constraints.
- `WARN`, `PARTIAL`, `UNAVAILABLE`, review candidates and metrics are investigation signals, not automatic conclusions.
- Ask the user with the host's native single- or multi-select UI only for a remaining authorization decision that facts cannot answer.

Use `scan`, `review`, `check`, `rules` and `docs` directly for their respective responsibilities.
