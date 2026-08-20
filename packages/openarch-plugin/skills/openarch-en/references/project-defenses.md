# Project Defenses

> “我们的任务是过河，但是没有桥或没有船就不能过。” — Mao Zedong, *Concern for the Well-Being of the Masses* (1934)

Read this page before selecting default assets, establishing a project defense, promoting a finding, or interpreting test, security, or anti-pattern coverage.

> This page is a specialized expansion of the `SKILL.md` Minimal Loop for “building project defenses / promoting rules”; rule-promotion steps follow this page, while the overall process remains the Minimal Loop as the single authority. Subagent parallelism conditions and lead-Agent responsibility are authoritative in the `SKILL.md` “Collaboration And Environment” section; this page only adds defense-scenario specifics.

## Select Assets From Evidence

Default scripts, templates, and providers are selectable references, never implicit policy. Select the smallest set from current `languages`, architecture facts, existing providers, and team intent. `openarch rules facts` only shows compatible template families; a recommendation is not installation, calibration, or gate eligibility.

Install a named reusable asset with `openarch init --install-script <id>`. Preserve existing project scripts; use `--replace-script <id>` only after confirming an uncustomized target has an outdated asset contract. Paths, layer weights, authority ranges, and thresholds must come from the governed project, not uncalibrated values from another project. Audit configuration changes with `check --record-config`.

## Protracted Defense

Anti-corruption is not one all-green scan; it is long-term active defense. Each change introduces uncertainty. Do not spread effort across every signal, and do not abandon a concern because it cannot yet be automated. Around the most evidenced pattern that most affects collaboration or change reliability, close the smallest loop before extending it: investigate facts and boundaries, build a verifiable defense, backscan existing code, repair or calibrate, then verify and record the experience. Humans, Agents, scripts, tests, and collaboration documents form this defense together; preserve every unknown honestly.

### Exploratory Collaboration

Split a complex concern into verifiable questions, not directories, roles, or guessed solutions. When a question has an independent source of evidence, does not modify the same file or state, and does not depend on another investigation's conclusion, use host-supported subagents for parallel investigation. Every subagent must return evidence, counterexamples, unknowns, affected scope, and reproducible commands; the lead Agent compares conclusions, resolves conflicts, and performs final verification.

Shared architectural judgment, several symptoms of one root cause, facts that must be established in order, and work that touches the same state are not parallel tasks. Parallelism expands observation; it never replaces problem framing, rule calibration, or final responsibility.

### Agent Output Contract

Anti-pattern and architecture prompts provide routing, not an unverified state machine. Action summaries separate facts (sources and commands), inferences (confidence and counterexamples), recommendations (preconditions and next step), and unknown or `UNAVAILABLE` states. Use the host's native single- or multi-select when the user must decide persistence, sharing scope, or policy promotion; do not turn routine checks into questions. Give each phase a reproducible command and stopping condition, and expand scope only after the loop `investigate -> defend -> backscan -> repair/calibrate -> verify/record` is closed.

### Build The Smallest Defense

For a reproducible corruption pattern:

1. Preserve a pre-fix observation, or a real historical revision or fixture when the repository is already clean.
2. Write the smallest project rule with a violation, legal alternative, and `UNAVAILABLE` fixture. Follow [script-authoring.md](./script-authoring.md).
3. Run `rules check`, then backscan with `rules scan` or `rules discover`.
4. Repair findings or record a justified boundary. A zero backscan is `CLEAN`, not failure.
5. Promote to `warn` or `block` only when positive examples, fixtures, and a current clean backscan exist. A selected rule that is `UNAVAILABLE` must fail closed.

Do not invent static rules for design intent, runtime behavior, broad data flow, business semantics, concurrency, authorization, `CVE`, or `SCA`. Structural signals only prioritize investigation; continue with code, history, contracts, external scanners, and tests.

## Test And Security Boundaries

Test providers produce framework facts while project policy controls finding severity and exemptions. `AVAILABLE`, `PARTIAL`, `UNAVAILABLE`, and `NOT_CONFIGURED` are independent from policy `PASS`. Unknown frameworks, custom runners, and incomplete collection remain partial while production governance can continue.

Direct API misuse or explicit static invariants may be report-only language or project rules. Taint, secrets, `CVE`, type or data flow, races, and business authorization need an external provider or focused human investigation. None of these findings enter `CRL` or `I_push`.
