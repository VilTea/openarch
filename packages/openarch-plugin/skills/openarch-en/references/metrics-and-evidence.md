# Metrics And Evidence

> “调查就是解决问题。” — Mao Zedong, *Against Book Worship* (1930)

Read this page before interpreting `I_push`, `CRL_state`, `D_MR`, `P95`, calibration signals, or a production-gate `WARN`.

## Evidence Boundary

A `Fact` is an observable, versioned input; a `metric` is reproducibly derived; a `finding` is a rule or provider result; a `signal` is diagnostic only; only `policy` yields `PASS`, `WARN`, or `BLOCK`. Do not connect signals, partial providers, evolution candidates, or another project's thresholds directly to the gate.

Unknown remains unknown. Missing parser, compiler, `LSP`, or Git evidence must be `UNAVAILABLE` or `PARTIAL`, never disguised as zero counts, low impact, or a clean finding.

## Change Impact `I_push`

`I_push = Σ λ_ast × α_struct × log2(inDegree + 1) × ω_layer × λ_joint` is an explainable upper bound on change propagation, not `LOC` or a quality score.

- `λ_ast` comes from the actual declaration diff: interface add/remove 100, class add/remove 80, public method signature 60, function signature 50, field add/remove 40, dependency removal 15, function body 10, confirmed compatible increment, branch, or dependency 5, and comments/formatting 0. New guards or cases scale by real weighted-branch delta.
- `α_struct` is confidence-bearing reverse `Reach`: it explains who may be affected, not what a file imports, and does not prove corruption.
- `inDegree` has diminishing return; `ω_layer` must come from project evidence, never a product default; `λ_joint` currently reflects only direct dependency-change completeness. `utilisation`, `spread`, and `γ_quality` remain uncalibrated.

For high impact, inspect change kind, public contract, reverse `Reach`, direct consumers, and layer weight. Split independent work, strengthen verification, or record why impact is necessary; never rename a real contract change to lower the score.

## Symbol-Scope Shadow Metric `symbol_scope`

The symbol-scope shadow formula is `S_symbol = lambda_ast * alpha_struct * log2(symbol_consumer_count + 1) * omega_layer`. It remains a freely refactorable in-memory experiment, not a separate compatibility commitment. `symbol_consumer_count` is the deduplicated repository reference set confirmed with complete declaration and reference coverage; static reverse-import consumers appear only as the parallel `staticComparableImpact`, never added to symbol consumers. The formula has no uncalibrated `gamma_quality` or coverage discount. If profile identity, common population, public surface, or either coverage dimension is incomplete, the metric remains `PARTIAL`/`UNAVAILABLE` and emits no value. This is a report-only shadow metric: it cannot change `I_push`, CRL, D_MR, baseline, history, or gate; file-level `I_push` remains the conservative upper bound.

## Current Burden And Trend `CRL_state`

`CRL_state` normalizes production files against project `P95` values and separates explanatory views:

- `localBurden = maxFuncBranch + nesting + loc + externalPassthrough` is the only current-burden family eligible for a calibrated gate.
- `exposure = α_struct` explains core position; a useful hub is not penalized merely for being depended on.
- `moduleShape = 1 - connectedness` explains internal-call shape; independent utilities should not manufacture calls.
- Historical `CRL` is time-decayed change load, not a current-structure verdict.

`maxFuncBranch`, `weightedBranchTotal`, and `topLevelBranch` are distinct facts and must not replace one another or create parallel branch tables. Only parser-confirmed direct non-local calls count toward `externalPassthrough`; member and dynamic dispatch remain unknown.

A normal `scan` updates observed `P95` only. A sealed calibration epoch remains the denominator for unchanged files. `scan --seal-calibration` is a reviewed team action. Observed/sealed deviation is `CALIBRATION_SHIFT`, report-only.

## Exploratory Policy Calibration

When `rules_warn`/`rules_block` is empty, the baseline scope is current, and complete `P95`/Top-3 facts exist, `review` shows the observed reference. These values are inputs to project calibration, not OpenArch defaults or portable cross-project thresholds. The Agent must state tolerance, sample scope, false-positive handling, and the rescan plan, then ask the owner to choose one minimal `WARN`, two independent `WARN`s, or a documented deferral. Do not auto-create a `BLOCK` on the first round; without complete P95, remain `UNAVAILABLE` rather than guessing from one file or another project.

Use `structural_policies` to calibrate separate populations in multi-language or multi-service repositories. Each profile declares its language set and may narrow to explicit project-relative `scope.include`/`scope.exclude`; language and scope intersect. Never infer a service from its directory, package, or import graph. Every production file must match exactly one profile: zero or multiple matches are `UNAVAILABLE`, never a reason to borrow a neighbouring language, service, or default threshold. After adding a scope, run a complete scan to establish its independent P95 before choosing observe or enforce.

## Change Diagnosis `D_MR`

`D_MR` is a production-only, report-only change diagnosis using the same `P95` family. It reports burden regression and improvement separately; they do not offset. `Δα_struct` explains only, while `connectedness` is excluded. A new file has only after facts; missing comparable before facts must remain `UNAVAILABLE`. Tests and auxiliary files never participate.

Use `D_MR` to inspect responsibility splitting, control flow, nesting, size, or orchestration in changed files. Without independent calibration evidence, never add it to the gate or `I_push`.
