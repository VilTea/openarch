# Metrics And Evidence

> “调查就是解决问题。” — Mao Zedong, *Against Book Worship* (1930)

Read this page before interpreting `I_push`, `CRL_state`, `D_MR`, `P95`, calibration signals, or a production-gate `WARN`.

## Evidence Boundary

A `Fact` is an observable, versioned input; a `metric` is reproducibly derived; a `finding` is a rule or provider result; a `signal` is diagnostic only; only `policy` yields `PASS`, `WARN`, or `BLOCK`. Do not connect signals, partial providers, evolution candidates, or another project's thresholds directly to the gate.

Unknown remains unknown. Missing parser, compiler, `LSP`, or Git evidence must be `UNAVAILABLE` or `PARTIAL`, never disguised as zero counts, low impact, or a clean finding.

## Change Impact `I_push`

`I_push = Σ λ_ast × branchMagnitude × α_struct × log2(inDegree + 1) × ω_layer` is an explainable upper bound on change propagation, not `LOC` or a quality score; `λ_joint` is frozen as a research item and is not part of the active formula.

- `λ_ast` comes from the actual declaration diff: interface add/remove 100, class add/remove 80, public method signature 60, function signature 50, field add/remove 40, dependency removal 15, function body 10, confirmed compatible increment, branch, or dependency 5, and comments/formatting 0. New guards or cases scale by real weighted-branch delta.
- `α_struct` is confidence-bearing reverse `Reach`: it explains who may be affected, not what a file imports, and does not prove corruption.
- `inDegree` has diminishing return; `ω_layer` must come from project evidence, never a product default; `utilisation`, `spread`, and `γ_quality` remain research items.

`I_push` is report-only routing evidence and does not enter the gate (the metric catalog marks it report-only). For high impact, inspect change kind, public contract, reverse `Reach`, direct consumers, and layer weight, and route verification effort accordingly: split independent work, strengthen verification, or record why impact is necessary; never rename a real contract change to lower the score.

Scale reference: the diff report also emits `intensity = I_push / Σ(λ_ast × branchMagnitude)` and the project-relative percentile `impactScale` among same-file-count sealed changes (compaction-weighted by `sourceEntryCount`); no same-size sample means undefined, never a zero percentile. Cross-project absolute comparison must wait for real multi-project scale regression; never treat one project's percentile as a universal conclusion.

## Symbol-Scope Shadow Metric `symbol_scope`

The symbol-scope shadow formula is `S_symbol = lambda_ast * alpha_struct * log2(symbol_consumer_count + 1) * omega_layer`. It remains a freely refactorable in-memory experiment, not a separate compatibility commitment. `symbol_consumer_count` is the deduplicated repository reference set confirmed with complete declaration and reference coverage; static reverse-import consumers appear only as the parallel `staticComparableImpact`, never added to symbol consumers. The formula has no uncalibrated `gamma_quality` or coverage discount. If profile identity, common population, public surface, or either coverage dimension is incomplete, the metric remains `PARTIAL`/`UNAVAILABLE` and emits no value. **This metric is a retired research shadow (calibrated 2026-08-15)**: catalog role=retired, so a gate rule referencing it is `unsupported_gate_metric`; there is no CLI or policy consumer, only an experimental API. It cannot change `I_push`, CRL, D_MR, baseline, history, or gate; file-level `I_push` remains the conservative upper bound.

## Current Burden And Trend `CRL_state`

`CRL_state` normalizes production files against project `P95` values and separates explanatory views:

- `localBurden = maxFuncBranch + nesting + loc + externalPassthrough` is the only current-burden family eligible for a calibrated gate. Its four raw inputs share one normalizer, `localBurdenInputsOf`: loc is implementation lines (declaration lines excluded) and externalPassthrough falls back to passthroughCalls; gate, review, D_MR, and calibration use the same inputs.
- `exposure = α_struct` explains core position; a useful hub is not penalized merely for being depended on.
- `moduleShape = 1 - connectedness` explains internal-call shape; independent utilities should not manufacture calls.
- Historical `CRL` is time-decayed change load, not a current-structure verdict.

`maxFuncBranch`, `weightedBranchTotal`, and `topLevelBranch` are distinct facts and must not replace one another or create parallel branch tables. Only parser-confirmed direct non-local calls count toward `externalPassthrough`; member and dynamic dispatch remain unknown.

`nestingDepth` counts only block and function boundaries (`blockTypes`: statement blocks, functions/methods, arrow functions, if/for/while/switch, class, try/catch); expression or object-literal nesting is not counted. Each arrow function in a chained `map`/`flatMap` counts as one level, so a pure data-assembly file can have a high `nestingDepth` without equivalent cognitive burden. A `deep-nesting` threshold is evaluated with `>=` (meeting the threshold triggers); interpret P95 against this definition, and keep a manual exemption judgement for pure data-assembly files.

A normal `scan` updates observed `P95` only. A sealed calibration epoch remains the denominator for unchanged files. `scan --seal-calibration` is a reviewed team action. Observed/sealed deviation is `CALIBRATION_SHIFT`, report-only. **Enforced populations with fewer than 50 production files are small samples**: gate output adds a caution (sealed/bootstrapped); P95 is unstable there, so treat thresholds as observational and avoid adding BLOCK.

## Retired And Closed-Loop Status (Calibrated 2026-08-15)

- Retired CEL variables: `branch_count`, `crl_state`, `crl_inputs`, `cohesion`, `function_count`, `symbol_scope` - using them in a gate rule is a configuration error.
- `testMetrics` persistence is retired: test governance is read-only and re-collects every run; `TEST_BLOAT` stays a report-only diagnostic behind `openarch test --bloat`, outside governance signals.
- `cohesion` is no longer written into new baseline shards; old shards remain read-compatible.

## Exploratory Policy Calibration

When `rules_warn`/`rules_block` is empty, the baseline scope is current, and complete `P95`/Top-3 facts exist, `review` shows the observed reference. These values are inputs to project calibration, not OpenArch defaults or portable cross-project thresholds. The Agent must state tolerance, sample scope, false-positive handling, and the rescan plan, then ask the owner to choose one minimal `WARN`, two independent `WARN`s, or a documented deferral. Do not auto-create a `BLOCK` on the first round; without complete P95, remain `UNAVAILABLE` rather than guessing from one file or another project.

Use `structural_policies` to calibrate separate populations in multi-language or multi-service repositories. Each profile declares its language set and may narrow to explicit project-relative `scope.include`/`scope.exclude`; language and scope intersect. Never infer a service from its directory, package, or import graph. Every production file must match exactly one profile: zero or multiple matches are `UNAVAILABLE`, never a reason to borrow a neighbouring language, service, or default threshold. After adding a scope, run a complete scan to establish its independent P95 before choosing observe or enforce.

## Change Diagnosis `D_MR`

`D_MR` is a production-only, report-only change diagnosis using the same `P95` family. It reports burden regression and improvement separately; they do not offset. `Δα_struct` explains only, while `connectedness` is excluded. A new file has only after facts; missing comparable before facts must remain `UNAVAILABLE`. Tests and auxiliary files never participate.

Use `D_MR` to inspect responsibility splitting, control flow, nesting, size, or orchestration in changed files. Without independent calibration evidence, never add it to the gate or `I_push`.
