# Theory–Feature Map

> This page is a **navigation page**, not a new rule and not a content copy. The authoritative content remains in `SKILL.md` and the references; this page only answers “where does a feature map to” and “which theory does a methodology map to”.

## 1. Feature Side: Command → Skill Content

| Feature | Skill entry | Reference |
|---|---|---|
| `init` | Minimal Loop steps 1/2 | [governance-lifecycle.md](./governance-lifecycle.md) |
| `context` | Investigate and judge | [agent-workflow.md](./agent-workflow.md) |
| `contract` | Cognitive-point principle, fail-closed | [project-defenses.md](./project-defenses.md) |
| `scan` | Metric compass, evidence boundaries | [metrics-and-evidence.md](./metrics-and-evidence.md) |
| `review` | Principal contradiction, report consumption discipline | [project-defenses.md](./project-defenses.md), [collaboration-and-evolution.md](./collaboration-and-evolution.md) |
| `check` | Minimal Loop, verdicts and gates | [metrics-and-evidence.md](./metrics-and-evidence.md), [agent-workflow.md](./agent-workflow.md) |
| `rules` | Cognitive-point net reduction, project defenses | [script-authoring.md](./script-authoring.md), [project-defenses.md](./project-defenses.md) |
| `docs` | Experience loop, DocumentStore | [governance-lifecycle.md](./governance-lifecycle.md), [record-guide.md](../record-guide.md) |
| `test` | Explicit test entry | [language-and-assurance.md](./language-and-assurance.md) |
| `toolchains` / `lsp` | Evidence boundaries, `PARTIAL/UNAVAILABLE` | [language-and-assurance.md](./language-and-assurance.md) |
| `update` | Governance lifecycle upgrades | [governance-lifecycle.md](./governance-lifecycle.md) |
| `coordination` | Collaboration and evolution, explicit boundaries | [collaboration-and-evolution.md](./collaboration-and-evolution.md) |
| `anti-patterns` / `calibration` | Smallest defense, report-only without fabrication | [project-defenses.md](./project-defenses.md), [metrics-and-evidence.md](./metrics-and-evidence.md) |

## 2. Theory Side: Methodology → Theory → Feature Landing

| Methodology | Theory/source | Feature landing |
|---|---|---|
| Seek truth from facts | *Against Book Worship*, *Reform Our Study* | `context`, `scan`, `check`, `review` |
| Preserve uncertainty | Shannon information, fail-closed | `contract`, `check`, `review` |
| Cognitive-point principle | Cognitive load theory, SSOT, DDD ubiquitous language | `contract`, `rules`, `docs`, `test` |
| Grasp the principal contradiction | *On Contradiction* | `review`, `rules`, calibration |
| Concentrate superior forces | Mao's military thought | `rules scan`, smallest defense |
| Concrete analysis of concrete conditions | *On Contradiction* | `language-and-assurance`, `review --evolution` |
| General call with individual guidance | *Some Questions Concerning Methods of Leadership* | `rules skeleton`, fixtures |
| Practice, knowledge, practice again | *On Practice* | `check`, `docs record` |
| Protracted war | *On Protracted War* | `project-defenses`, CI/hooks |
| Ubiquitous language / SSOT | Information theory, DDD | `contract`, schemas, `rules facts` |

## 3. Usage Rules

- This page is navigation only; it does not contain metric formulas, command help, or methodology explanations.
- When adding a command or methodology, update this page first, then decide whether to change `SKILL.md` or a reference.
- On conflict, `SKILL.md` and the corresponding reference are authoritative; this page is not.