# Agent Workflow Routing

This page turns reusable lessons from external Agent prompts and skills into an OpenArch usage route. It is an action contract, not a new CLI state machine and not a substitute for user decisions.

> “没有调查，没有发言权。” — Mao Zedong, *Against Book Worship*

## Routing Principles

Every action has five boundaries:

1. **Object and fact boundary**: the actual object's identity, fact producer, scope, lifecycle, and current observation snapshot; a name, report, or neighboring-layer test is not automatically equivalent.
2. **Trigger fact**: why the action is needed now and which command, file, or provider supplied the fact.
3. **Primary action**: choose one smallest OpenArch command or investigation action; do not turn every command into a fixed workflow.
4. **Observed result**: read the verdict, coverage, findings, evidence, and `UNAVAILABLE/PARTIAL` states.
5. **Stopping condition**: when this investigation is sufficient, and when to repair, ask the user, or narrow the investigation.

`PASS` only means that declared policy did not trigger. Missing policy, incomplete evidence, or an unavailable provider must not be described as clean.

Start with `openarch context` to obtain the initial project fact projection, then choose one action from the table that reduces the most uncertainty. The route carries this cognitive chain; it does not add a CLI state machine.

## Minimal Route Table

| Current fact | Primary action | Observation and stopping condition |
|---|---|---|
| Configuration or governance state is unknown | `openarch context` | Complete the fact projection first; run `init` only when config is absent and `scan` only when baseline is absent. Stop when state is known. |
| Baseline is current and architecture policy is `UNCONFIGURED` | `openarch review` | Do not treat PASS as health; use P95/Top-3 to start exploratory calibration and let the project owner choose one WARN, two independent WARNs, or a documented deferral. Never auto-create a BLOCK on the first round. |
| Worktree has unstaged changes | `openarch check --worktree --report` | Read I_push, D_MR, evidence source, and pending evidence. Record semantic uncertainty instead of treating fallback as complete semantics. |
| Git index is staged for commit | `openarch check --staged --report` | Judge only the index snapshot. Investigate real change kinds or add evidence when semantic facts are missing; do not relax the gate first. |
| A module is repeatedly edited or existing risk needs explanation | `openarch review` / `review --evolution` | Treat top burden, co-change history, and findings as investigation leads only. Establish a concrete pattern before creating a script or project contract. |
| A reproducible static corruption hypothesis exists | `openarch rules facts` -> choose a skeleton -> `rules check` -> `rules scan` | Preserve a positive example or historical revision, then scan legal, violating, and unavailable samples. A post-repair zero is `CLEAN`; it is not proof of unvalidated coverage. |
| Test framework or collection boundary is uncertain | `openarch check --tests` or `review` | Separate provider coverage from policy verdict. `UNAVAILABLE/PARTIAL` limits test governance only and does not stop production investigation. |
| A capability, script, or experience document changes materially | `openarch docs status` / `docs check --changed <path>` | Update only the current project's DocumentStore. Product Skill, runtime mirrors, and release assets are maintained by the product repository. |

This table is not a mandatory sequence. When several rows match, choose the row that reduces the most uncertainty and state why the others were not run.

## Agent Summary Contract

After each investigation or repair, report in this structure:

```text
Facts: commands run, actual output, evidence source, and scope
Inference: explanation from the facts, confidence, and counterexamples
Recommendation: next action, preconditions, and boundary it may change
Unknowns: UNAVAILABLE/PARTIAL, unverified semantics, and residual risk
Stopping condition: when this round ends, or when user direction or more investigation is required
```

Do not turn an inference into a finding, a recommendation into a gate, or “handled” into a substitute for a reproducible verification command.

## User Choices And Subagents

Ask the user only when persistence mode, shared-document scope, policy promotion, an irreversible edit, or an external side effect changes the result:

- Use the host's native single-select for one mutually exclusive dimension and multi-select for independent defense families.
- State the impact and evidence gap for each option; routine `scan/check` should not manufacture a choice.
- If the host has no native choice UI, fall back to short numbered options rather than burying the question in prose.
- First policy calibration is also a user choice: report P95/Top-3 and evidence scope, then let the owner choose one minimal WARN, two independent WARNs, or deferral. The Agent must not silently keep policy unconfigured or write thresholds on the owner's behalf.

Use subagents only for independent evidence sources that do not modify the same files or state and do not depend on each other's conclusions. Each subagent answers one question and returns evidence, counterexamples, unknowns, scope, and reproducible commands. The lead Agent resolves conflicts, changes shared state, and performs final verification.

## Experience Loop

When the same corruption pattern returns, first encode the stable invariant as a project script, contract, or test, then scan and repair the existing instances. Patterns that depend on design intent, runtime semantics, or expensive whole-program analysis remain project experience and investigation guidance; do not invent a static rule. Experience belongs to the current project and must not be written back to the installed Skill.
