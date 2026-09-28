# Gate Verdict Response Guide

> “世界上怕就怕‘认真’二字，共产党就最讲认真。” — Mao Zedong, *Speech at the National Conference on Propaganda Work* (1957)

Read command output and current project policy before responding to `PASS`, `WARN`, or `BLOCK`. When data conflicts with intuition, revise the judgment, not the fact.

## Exit codes: how facts and verdicts come back

The exit code is the machine-readable interface between the agent and the gate. **`0` does not mean healthy, and `3` does not mean the change is wrong**:

| Exit | Meaning |
|------|---------|
| `0` | No declared policy triggered (`PASS`), or the command completed. **Not clean**: report-only metrics, findings, and `PARTIAL`/`UNAVAILABLE` details may still be in the output |
| `1` | Facts to explain: a declared policy `WARN`, configuration-audit `drift`, or `review`/`diff` found facts to investigate (`review` also returns `1` when governance review is unavailable) |
| `2` | A declared policy `BLOCK` (hard constraint), or a test-policy verdict of `BLOCK` |
| `3` | **Facts unavailable, or a configuration/environment error** (`UNAVAILABLE` and errors both fail closed to `3`): missing baseline, incompatible analysis scope or language-shape identity, unusable configuration, usage error, parse/IO/schema failure |

- `openarch check` returns the **combination** of its parts (strongest wins: `3 > 2 > 1 > 0`): the gate verdict + the configuration audit (`drift` → `1`; uninitialized only warns → `0`) + explicit `protected_paths` + test governance under `--tests`.
- The same `3` may mean "the baseline must be rebuilt" or "the configuration is wrong", and the next step differs entirely: **read `Verdict:` / `Status:` / reason / `Diagnostic:` in the output before acting**.

## `UNCONFIGURED`

When no `rules_warn` or `rules_block` is declared, `PASS` means only that no declared policy triggered. If the baseline is current and P95/Top-3 facts exist, run `openarch review`, start exploratory calibration, and let the project owner choose one minimal WARN, two independent WARNs, or a documented deferral. Do not copy another project's thresholds or create a BLOCK automatically on the first round.

## `PASS`

`PASS` means declared policy did not trigger. It does not prove health or coverage for unconfigured rules, unsupported providers, or `UNAVAILABLE` scope.

## `WARN`

A `WARN` is not a mandate: it only means one declared policy triggered, and whether to act on it is the project owner's decision.

1. Confirm the rule, files, measured values, and evidence state, and confirm the `mode` of the `structural_policies` population it came from: `enforce` in the report means that policy produces verdicts, while an `observe` population produces none.
2. Separate gate facts, incremental diagnostics, and explanatory signals; no isolated metric proves corruption.
3. Choose one of three paths - repair, accept with a recorded decision (`docs record`), or recalibrate through an audited config change - and state the reason and revisit condition. Do not lower thresholds, alter classification, or delete evidence merely to pass.

## `BLOCK`

An Agent must not bypass `BLOCK`. Repair the actual violation. If the project owner explicitly changes policy, record the reason and complete configuration audit first. Then rerun proportional language verification and `openarch check --staged --report`, and report the result.
