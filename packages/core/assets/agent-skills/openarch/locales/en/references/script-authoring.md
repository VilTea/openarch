# Project Script Authoring Contract

> “从群众中来，到群众中去。” — Mao Zedong, *Some Questions Concerning Methods of Leadership* (1943)

Read this page in full before creating, changing, or reviewing an implicit-dependency, anti-pattern, or test-finding script. It describes released public extension points only; do not change the parser, language registry, WASM grammar, internal storage, or CLI to fit one adopting project.

## Choose The Right Engine First

The three script engines share the same staged runtime but differ in output and backscan:

| Engine | Rule directory | `link` output | Backscan command |
|---|---|---|---|
| anti-patterns | `.openarch/anti-patterns/rules/*.mjs` | `finding` (at least `ruleId/file/message`; `scope: "file"|"repository"|"change_set"`) | `openarch rules scan` / `rules scan --check` |
| implicit-deps | `.openarch/implicit-deps/rules/*.mjs` | `edge[]` or `{ edges, observations }` (`from/to/via/type`) | `openarch rules discover` |
| test-governance | `.openarch/test-governance/rules/*.mjs` | `finding` (test-specific facts) | `openarch test` |

Run `openarch rules facts` first to inspect fact capability and consumer counts, then choose the engine and skeleton.

## Select Facts And A Skeleton

Write the claim as a verifiable fact, then choose the smallest boundary:

| Fact to prove | Run first |
|---|---|
| Single-file AST shape | `openarch rules skeleton staged-ast` |
| Classified file or path role | `openarch rules skeleton classification` |
| Existing structural metrics | `openarch rules skeleton metrics` |
| Static-import violation inside an authority | `openarch rules skeleton authority-import` |
| Authority violation in a bounded Git change set | `openarch rules skeleton authority-change-set` |

Run `openarch rules facts` first to confirm project languages and released fact capability. A `skeleton` only prints and never writes the project; use it to start a project script in `.openarch`. Do not guess Tree-sitter node names from memory or copy a query from another language. One pattern may have language-specific implementations and legal boundaries.

Do not disguise design intent, runtime behavior, broad type or data flow, business semantics, or expensive whole-program analysis as a static script. Use `review` and focused investigation to record facts, hypotheses, and unknowns; record `Debt` when appropriate.

## Fixed Execution Model

File or repository rules export one `default` object and follow engine order:

```js
export default {
  scope: "file",
  targets: { fileKinds: ["production"] },
  requires: ["file-classification.v1"],
  stages: {
    text: ({ files, text }) => files.filter((file) => text(file).includes("candidate")),
    ast: { pattern: "(identifier) @name", extract: (matches) => matches.map(() => ({})) },
  },
  link: ({ records, facts }) => [],
};
```

`text -> ast -> link` is fixed: `text` prunes candidates, `ast` handles candidates only, and `link` consumes records only. Do not enumerate the project, issue queries, read Git/configuration/baseline, calculate metrics, or schedule scripts yourself. Reusable derived information must first become a runtime fact, not cross-script state or ordering.

`ast` may select an engine-owned fact stage without writing a query: `{ fact: "static-imports.v1" }` supplies parser-confirmed static import sources; `{ fact: "string-key-calls.v1" }` supplies JS/TS declarative string-key syntax — string-key member calls, object-property string values, local string/ternary constants, string arrays (such as `inject`), and identifier-argument calls. DI/RPC/event-bus/HTTP-route cross-file correlation only pairs these keys semantically: do not duplicate the query, clean quotes, or resolve local variables. string-key-calls covers JS/TS syntax only; exclude non-JS/TS candidates with `targets.languages`, otherwise the rule stays unavailable instead of reading zero keys.

A change-set rule exports only `scope: "change_set"`, required `requires`, optional `staticImports`, and `detect`. It consumes engine-supplied bounded `changeSet` and `facts`; it cannot call Git or scan the repository.

## Available Facts And Boundaries

Declare only required capabilities in `requires`. `file-classification.v1` supplies normalized paths, `fileKind`, and `pathClass`; `structure-metrics.v1` supplies compatible-baseline raw structure and graph facts; `authorities.v1` supplies explicit authorities, protected files, and prohibited imports; `test-case-spans.v1` supplies provider-confirmed test-body spans; `invocation-bindings.v1` supplies parser-confirmed local receiver or alias bindings.

These capabilities do not infer directory intent, layer weights, `P95`, `CRL`, `I_push`, gate, threshold, owner, object flow, or dynamic dispatch. `PARTIAL` and `UNAVAILABLE` are not zero. When a required fact is incomplete, the rule stays unavailable rather than passing with an empty finding.

**Fact self-description and observability**: every registered fact maintains its own `domain/status/producer/usage/outputs` (`rules facts` is the single authority). Use `openarch rules facts [--domain <domain>] [--query <text>] [--status <status>] [--unused] [--json]` to search meaning, usage, output shape, and installed-script consumer counts. Zero-consumer facts are marked `UNUSED` (report-only); a new fact must fill the descriptor fields and explain its lifecycle (`experimental` or a real consumer) so the fact catalog cannot grow without an owner.

**Fact domains**: `classification` (file classification), `structure` (structural metrics), `authority` (authority boundaries), `test` (test facts), `semantic` (semantic relations and bindings), `change` (change surface), and `ast` (engine AST facts). The domain-filtered fact contract is exposed as the `rules-facts-json-v1` machine contract. CI can run `openarch rules check --unused`: zero-consumer facts exit `1` (WARN semantics, non-blocking); invalid contracts still exit `3`.

## Targeting, Authority, And Output

Declare `languages`, `include`, `exclude`, `fileKinds`, `pathClasses`, or `authority` in `targets`. A language-specific script must declare `languages`; the engine selects through the shared language registry before text or AST work, so an extension glob is never its only language boundary. Globs use project-root-relative POSIX paths; do not hand-write path normalization, `startsWith`, or directory-membership logic. Put reusable authorities in configuration; a rule-only authority can be declared at rule top level and the engine derives `protectedFiles` and `authorityIds`. Do not infer authority from a class name, filename, project directory, or import.

Use the `authority-import` skeleton and `static-imports.v1` for static-import boundaries; do not rematch import ASTs per language or parse source with regex. Dynamic imports, unresolved syntax, and unsupported languages must remain `UNAVAILABLE`. Use `string-key-calls.v1` for declarative string-key relations (DI/RPC/event buses); the engine owns the JS/TS query and string cleaning, and the script keeps only key semantics — Cordis-style declarative dependencies without imports are built on this fact.

An implicit-dependency `link` may return an edge array (legacy contract) or `{ edges, observations }`. `observations` are report-only (`unresolved_key | dynamic_key | note`, with `via` and `files` required and `message` optional), shown by `openarch rules discover`, never stored as edges, and never enter the gate. Write project-unresolved providers as `unresolved_key` and dynamic keys as `dynamic_key`; do not fabricate endpoints or treat unknown as zero.

A finding includes at least `ruleId`, `file`, and `message`. Supply line numbers only from a directly retained parser capture `line` or `endLine`, never by text-search guesswork. Findings are report-only by default and do not enter the gate, `CRL`, or `I_push`.

## Calibration Loop

1. Preserve a pre-fix observation and define violation, legal alternative, and `UNAVAILABLE` fixture.
2. Author the rule, run `openarch rules check`, then backscan with `openarch rules scan` or `openarch rules discover` and confirm it can hit existing cases.
3. Repair existing cases and backscan to `CLEAN`; retain the pre-fix observation, historical revision, or real regression fixture as a positive example.
4. Select `warn` or `block` in existing `quality_rules` only with sufficient authority, positive examples, and fixtures, then verify with `openarch rules scan --check`.

No existing hit does not fail automatically: with a positive example it is `CLEAN`; without one it is `UNVALIDATED`. Never connect a report-only finding directly to a gate or formula.

To investigate direct class/interface relationships, a script may declare `requires: ["semantic-relations.v1"]` and consume provider-proven edges from `facts.semanticRelations.value.relations`. These facts contain only direct `extends`, `implements`, explicit type, and construction edges plus language/provider/coverage/evidence. They are not a complete call graph, transitive dependency graph, or runtime object-flow model. Do not start an LSP server, build a compiler project, or rescan the workspace from a script; leave the rule `UNAVAILABLE` or `PARTIAL` when provider coverage is incomplete.
