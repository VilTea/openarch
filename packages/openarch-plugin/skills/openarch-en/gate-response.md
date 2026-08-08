# Gate Verdict Response Guide

> “世界上怕就怕‘认真’二字，共产党就最讲认真。” — Mao Zedong, *Speech at the National Conference on Propaganda Work* (1957)

Read command output and current project policy before responding to `PASS`, `WARN`, or `BLOCK`. When data conflicts with intuition, revise the judgment, not the fact.

## `UNCONFIGURED`

When no `rules_warn` or `rules_block` is declared, `PASS` means only that no declared policy triggered. If the baseline is current and P95/Top-3 facts exist, run `openarch review`, start exploratory calibration, and let the project owner choose one minimal WARN, two independent WARNs, or a documented deferral. Do not copy another project's thresholds or create a BLOCK automatically on the first round.

## `PASS`

`PASS` means declared policy did not trigger. It does not prove health or coverage for unconfigured rules, unsupported providers, or `UNAVAILABLE` scope.

## `WARN`

1. Confirm the rule, files, measured values, and evidence state.
2. Separate gate facts, incremental diagnostics, and explanatory signals; no isolated metric proves corruption.
3. Use responsibility, dependencies, and the change objective to repair, accept risk, or propose an auditable policy adjustment. Do not lower thresholds, alter classification, or delete evidence merely to pass.

## `BLOCK`

An Agent must not bypass `BLOCK`. Repair the actual violation. If the project owner explicitly changes policy, record the reason and complete configuration audit first. Then rerun proportional language verification and `openarch check --staged --report`, and report the result.
