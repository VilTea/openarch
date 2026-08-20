---
name: openarch
description: |
  Assess architectural impact, test governance, and anti-patterns from local evidence
  in an initialized OpenArch project, then run verification that matches project policy.
---

# OpenArch Governance Constitution

OpenArch provides local, auditable constraints for coding agents. It reports facts and project-policy verdicts; it does not orchestrate the user's work. Do not weaken rules, skip verification, or call uncertainty clean merely to pass a check.

## Operating Principles

> “没有调查，没有发言权。” — Mao Zedong, *Against Book Worship* (1930)

Investigation precedes judgment: inspect `openarch context`, configuration, baseline, code, and real output before drawing conclusions.

- **Seek truth from facts (practice loop)**: inspect `openarch context`, configuration, baseline, code, and real output; a conclusion across a boundary must be tested against the corresponding object and setting. `PARTIAL` and `UNAVAILABLE` are not zero or clean.
- **Information theory (preserve uncertainty)**: distinguish fact, metric, finding, signal, policy, and calibration, while retaining identity, provenance, scope, lifecycle, and observation range. Scripts and providers consume explicitly scoped facts; only facts crossing lifecycle or ownership boundaries are versioned, and diagnostic signals do not enter the gate.
- **Cognitive-point principle (principal contradiction / net reduction)**: maintainability is driven mainly by how many independent cognitive points a maintainer must remember, not by `LOC`, class count, or module count. Keep one authoritative entry per important concept; before adding an abstraction, module, doc path, or install path, ask whether it increases cognitive points. Parallel implementations, duplicate concepts, inconsistent naming, hidden conventions, and doc/implementation drift all grow cognitive points. SSOT, consumer analysis, ubiquitous language, and documentation/contract verification are its engineering tools. OpenArch structural metrics are proxies, not cognitive load itself.
- **Red Army experience (concrete, protracted defense)**: corruption returns with change, so do not chase one clean run. Build the smallest defense around the principal contradiction and its concrete conditions; backscan, repair/calibrate, verify/record in local real samples, then extend it. Do not bypass `BLOCK`.

## Terms And States

- Fact states are unified as `AVAILABLE` / `PARTIAL` / `UNAVAILABLE` / `NOT_CONFIGURED`; `PARTIAL`/`UNAVAILABLE` are fact boundaries, not zero or clean.
- Policy verdicts are unified as `PASS` / `WARN` / `BLOCK`; only project policy produces verdicts, and metrics, findings, and signals never enter the `gate` by themselves.
- Metrics and formulas are authoritative only in [metrics-and-evidence.md](./references/metrics-and-evidence.md); this file keeps summaries only.
- The Minimal Loop is the single authoritative process; [agent-workflow.md](./references/agent-workflow.md) and [project-defenses.md](./references/project-defenses.md) are specialized expansions of it, not parallel processes of equal status.

## Investigate And Judge

**Cognitive chain (run it before every judgment)**: `claim -> actual object/boundary -> fact producer, scope, and lifecycle -> observation carrier, time, and environment -> principal contradiction and counterexample -> smallest validating practice`. In an initialized project, use `openarch context` for initial project facts, then choose one route action that reduces the most uncertainty; this is not a new CLI state machine.

- **Establish object and boundary**: a name, interface, configuration, or report is not the actual object, and a local observation is not a cross-boundary conclusion. When a judgment crosses implementation, deployment, persistence, time, ownership, or environment, record object identity, producer, scope, lifecycle, input snapshot, and observation point; verify through the same fact carrier, never a neighboring-layer test.
- **Form a falsifiable judgment**: read current code, configuration, baseline, history, and existing rules; find a comparable working sample, then state the smallest hypothesis and check. A filename, similar text, one metric, or one scan is a clue only. Preserve semantics local facts cannot decide as unknown; never disguise them as a default gate.
- **Examine impact and disagreement**: when public behavior, persisted data, cross-component collaboration, or developer use may change, investigate what changes, dependents, failure boundary, and the proof offered by existing interfaces or tests. When sources disagree, preserve their identities and scopes; the difference is a fact, not something to erase by majority, authority, habit, or expectation.
- **Move from local to general**: reuse validated capabilities; keep internal experiments malleable, requiring migration or rejection only at real external compatibility boundaries. Backscan, repair/calibrate, and verify general guidance in local samples under differing conditions before promotion; one project's symptom and repair remain project experience.
- **Review for cognitive-point net reduction**: in review or refactoring, explicitly ask how many mental entries this concept has: where is the authoritative definition, who consumes it, who changes it, what must be checked before deletion, whether documentation and implementation agree, and whether a new abstraction has at least two real callers. Design judgments that cannot be statically proven stay as `review` heuristics; do not pass them off as metrics or a `gate`.

## Collaboration And Environment

- External semantic tools belong to the Agent or CI global environment. They may read project configuration, interpreters, and dependencies, but must not change the project's manifest, lockfile, `node_modules`, or `.venv` for OpenArch.
- **The coordination service is an explicit optional capability**: local OpenArch works independently by default, and a shared Git document store does not imply that a coordinator exists. Shared mode has one remote DocumentStore: the Agent's `--docs-repo` association, the service worktree, and the descriptor returned by the service all name the same remote and branch; a service address never introduces a second repository. Only after the user explicitly runs `openarch init --coordination-url <https://...>` during initialization or later may the project attempt remote Tasks, meetings, or semantic locks. Never infer an address from a Git remote, `--docs-repo`, directory, service name, or environment; without it, those remote operations are `UNAVAILABLE` and local governance continues.
- When a question spans independent modules, languages, or candidate causes, use host-supported subagents for parallel exploratory investigation only: give each one question, and require evidence, counterexamples, unknowns, and affected scope. The lead Agent compares results and performs final verification. Do not replace investigation with parallelism when conclusions, files, or state are shared.

## Metric Compass

- `I_push` is an upper bound on change propagation from declaration semantics, reverse structure propagation, direct consumers, project-layer sensitivity, and dependency synchronization. It is not `LOC` or a quality score. Inspect contracts, classification, `Reach`, and the validation plan before acting on a high value.
- `CRL_state` observes current local burden against project `P95` values: maximum function branching, nesting, effective lines, and direct external orchestration. `α_struct` explains exposure and `connectedness` explains module shape; neither convicts a file alone.
- `D_MR` diagnoses local-burden improvement or regression for this production change only. It is displayed separately, does not offset other values, and never enters the gate; tests and auxiliary files do not participate.
- Cognitive points are not a numeric metric: `CRL_state`/structural metrics are proxies for cognitive burden, not cognitive points themselves. Cognitive-point net reduction is used as a `review` heuristic and report signal, not a `gate`.

Read [metrics-and-evidence.md](./references/metrics-and-evidence.md) for factors, calibration epochs, coverage, and action boundaries.

## Minimal Loop

> The Minimal Loop below is the single authoritative process; other reference pages may expand or cite it, but must not create another process of equal status.

1. Run `openarch context`. Initialize when configuration is absent; scan when the baseline is absent; do not stage pre-emptively. When the baseline scope is current and `architecturePolicy=UNCONFIGURED`, do not stop at `PASS`: run `openarch review`, use its P95/Top-3 facts to start exploratory policy calibration, and use the host's native single/multi-select UI to let the project owner choose “trial one minimal WARN, trial two independent WARNs, or defer and record why.” The first round must not write configuration or create a BLOCK automatically; every threshold needs a tolerance, sample scope, and rescan plan. **After changing `structural_policies`/`file_kinds` configuration, run `openarch scan --rebuild`** (incremental scan short-circuits on content `SHA-256` and does not notice configuration changes; otherwise the gate reports `policy_calibration_missing` or keeps the old scope).
2. Before editing, read the current project's bound capability asset, when one exists, and task-relevant experience. State which project capability is reused, or why it is not applicable. An integrated project maintains only its own assets, rules, and records. The installed OpenArch Skill, runtime/plugin mirrors, and release assets are read-only inputs; report stale or mismatched content upstream instead of editing it in the integrated project. Only a repository explicitly maintaining the product release may update those sources and mirrors through its own release process. Report missing scope or assets as unavailable.
3. After implementation, use `openarch check --worktree --report --output-mode summary` for unstaged work; escalate to `--output-mode detail` for consumers/change-surface/formula details, `--output-mode full` for complete MR/symbol admission drill-down, and `--human` for human-readable output. When a non-TypeScript project needs higher-fidelity symbol references or consumer evidence, configure its global LSP toolchain, then run `openarch check --worktree --semantic --report --output-mode detail` and read the actual provider, coverage, and risks. Routine output is an action summary; add `--verbose` only to investigate D_MR, symbol evidence, or formula admission. Use `openarch check --staged --report --output-mode summary` when preparing a commit; LSP reads the worktree and cannot stand in for Git-index evidence. Run `openarch review` first when a file is repeatedly edited or the user asks for architectural review.
4. When a capability, provider, script, configuration, or command changes in the current project, follow that project's DocumentStore contract and run `openarch docs check --changed <path>`; do not create or edit an asset that is absent or outside the project. Record only a reviewable conclusion.

When automatic semantic evidence is unavailable for production code, investigate the whole batch and use per-file `--change-override path=actual-kind` once. Do not turn unknown into `function_body`. Tests and auxiliary files do not enter production `I_push` or `D_MR`.

## Verdicts And Authorization

- `PASS` means only that declared policy did not trigger; an absent project rule does not mean healthy.
- Investigate `WARN` facts, responsibility, and boundary. Repair, accept risk, or adjust policy through audit; do not merely lower a threshold.
- Repair `BLOCK`, or have the project owner explicitly change policy through audit. See [gate-response.md](./gate-response.md).
- For first calibration, persistence mode, or shared-document scope, investigate first and request authorization through the host's native single- or multi-select UI. Do not disguise routine checks as a choice.

## Report Consumption Discipline

`check`/`review` output is the **full signal surface**, not one Verdict line. Consume every section before claiming completion; never stop at the Verdict:

- **A Verdict is only the decision of declared policy, not a completion criterion.** On `PASS`, still read all WARN details, `TEST_BLOAT`/test governance, anti-pattern findings, structural candidates, and the signals section.
- **Every signal must be responded to**: `PARTIAL`/`UNAVAILABLE` is a fact boundary (e.g. `TEST_GOVERNANCE_COVERAGE`, unavailable providers, `MISSING_BASELINE`) - either handle it (`scan` to refresh the baseline, configure toolchains, fix provider coverage) or record why; never ignore it or treat PARTIAL as clean.
- **Reclassify anti-pattern findings one by one**: real positives -> fix or record a legitimate boundary; do not skip findings just because they are not `BLOCK`.
- **Top-3 structural candidates** are governance candidates when they persist; on every appearance decide "fixed / introduced by this change / known boundary" and state it at the end.
- **Zero or documented signal surface before committing**: a `PASS` from `check --staged --report` must come with the explicit statement "no unhandled signals"; handle them first otherwise.

## Read One Reference On Demand

| Task or signal | Required reference |
|---|---|
| `I_push`, CRL, `D_MR`, `P95`, calibration, or `WARN` interpretation | [metrics-and-evidence.md](./references/metrics-and-evidence.md) |
| initialization, hooks, personal/team persistence, evidence, DocumentStore, records, or Skill upgrades/refresh | [governance-lifecycle.md](./references/governance-lifecycle.md), then [record-guide.md](./record-guide.md) when needed |
| authoring, changing, or calibrating a project script or authority; inspecting fact capability/consumers, AST facts, and script observations | [script-authoring.md](./references/script-authoring.md) |
| default assets, anti-pattern/security/test findings, or policy promotion | [project-defenses.md](./references/project-defenses.md) |
| Agent routing, summary contract, user choices, subagents, or stopping conditions | [agent-workflow.md](./references/agent-workflow.md) |
| multi-repository work, Task/Debt, or `review --evolution` | [collaboration-and-evolution.md](./references/collaboration-and-evolution.md) |
| language parsers, test providers, compiler/`LSP`/`SCIP` semantics | [language-and-assurance.md](./references/language-and-assurance.md); when an external toolchain is unavailable, run `openarch toolchains`, then read the matching `references/toolchains/{python,go,rust,java}.md` file for the project language |
| methodological source quotations | [methodological-sources.md](./references/methodological-sources.md) |
| feature–theory overview; adding a command or methodology | [theory-and-feature-map.md](./references/theory-and-feature-map.md) |

## Completion

Run language checks, tests, and OpenArch verification proportional to the change. When `quality_rules` are configured, run `openarch rules scan --check`; use `openarch rules check --unused` to surface zero-consumer fact catalog health (WARN hint). For document or experience changes, run similarity checks in the actual DocumentStore. Do not delete pending evidence or baseline fragments to manufacture a clean commit: investigate identity, reachability, and reconciliation first.
