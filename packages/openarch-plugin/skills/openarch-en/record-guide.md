# Experience Record Guide

> “读书是学习，使用也是学习，而且是更重要的学习。” — Mao Zedong, *Problems of Strategy in China's Revolutionary War* (1936)

Experience records are structured post-action reviews, not a diary for every `WARN`. Record verified facts, judgment, and outcome; preserve uncertainty when evidence is insufficient.

## When To Record

| Situation | Category | Required evidence |
|---|---|---|
| Verified improvement or refactor | `patterns` | Explainable causal evidence |
| Recurrent or review-confirmed failure | `anti_patterns` | Trigger, harm, and verified alternative |
| Architecture or governance choice | `decisions` | Context, alternatives, and rationale |

Do not record routine actions, conclusions without new evidence, or results that cannot be reviewed. A single refactor may create separate pattern and decision records; do not let a default category guess the meaning.

## Loop

```bash
openarch docs record --category patterns "summary"
openarch docs check --changed <generated-document-path>
```

Write content before checking similarity candidates. Candidates are report-only; the Agent decides whether to merge, cross-reference, or retain separation and records that decision. The DocumentStore's commit process depends on the current project or shared scope, so never turn a sample repository path into a universal command.

## Writing Standard

State the background, raw evidence, analysis, action, verification result, applicability, and counterexamples. Another Agent should be able to understand what happened, why the decision was made, and when not to reuse it three months later.
