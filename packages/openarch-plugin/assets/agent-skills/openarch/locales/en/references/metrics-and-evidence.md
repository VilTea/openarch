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

### Branch weight semantics (this section is the single authoritative statement)

`maxFuncBranch` is a **weighted sum**, not a branch count:

| Shape | Weight |
|---|---|
| Ordinary `if` / `switch` itself / `match` itself | `1.0` |
| Guard clause (`if` whose first body statement is `return`/`throw`/`break`/`continue`) | `0.3` |
| `case` / `default` labels, `match` arms | `0.3` |

The judgment has exactly one implementation, `StructuralFacts.createGuardClauseDetector`; a language only declares which nodes are jumps and which nodes are containers. Therefore **braced and brace-less equivalent forms must score identically** (calibrated 2026-09-25: previously TS/JS recognised only the brace-less form and Java only the braced form, so adding braces to one line changed the score). If two equivalent spellings score differently, that is a defect in the judgment — report it instead of refactoring around it.

`maxFuncBranchOwner` is the attribution projection of the same fact: it carries the function's `name`, `line`, and the shape split `ordinaryIf`/`guardIf`/`caseCount`, so `weighted` can be recomputed as `ordinaryIf × 1.0 + (guardIf + caseCount) × 0.3`. It is report-only and never enters gate arithmetic; its purpose is to make the cost of "splitting for a WARN" visible before you act.

### Cognitive-point proxies (use them when reading and when writing)

Structural metrics are **proxies** for cognitive burden, not cognitive points themselves. When a structural signal fires, check the cognitive-point principle:

- Where is the single authoritative definition of this concept? Has a second parallel implementation appeared (the same judgment, list, or semantics written in two files)?
- Does the abstraction this change adds have **at least two real callers**? A private helper with a single call site is usually a **net increase in cognitive points**, even when it lowers `maxFuncBranch`.
- Rising `connectedness` (`moduleShape = 1 - connectedness`) means the file is more fragmented; rising `D_MR` line count means more code. Mechanical decomposition can turn the gate green while both of those get worse — report the trade-off instead of treating green as done.

#### Single-call-site helper share must be read together with disconnectedness

Both are projections of the **same intra-file call graph**, computed once by `computeInternalCallShape` in `domain/cohesion.ts` (which also yields `connectedness` and `cohesion`):

- `moduleShape = 1 - connectedness` answers "are the internal functions still together?";
- `singleCallSiteRatio` answers "are these real abstractions or mechanical splitting?" (denominator = functions called **at least once from inside the file**).

**How to read them**: the signature of purely mechanical decomposition is **high connectedness plus a high single-call-site share** — every helper is called exactly once by the main function, so they all sit in one component: `moduleShape` is near 0 (it looks healthy) while the share approaches 1. Reading connectedness alone marks "a pile of use-once helpers" as healthy. Conversely, an **undeterminable** share (no in-file call site, or a baseline that predates this fact) is a different statement from a large `moduleShape`; the report prints "not determinable" rather than `0`.

It is a **report-only companion value**: it adds no `CRLStateWeights` dimension, no `P95Values` slot, and no gate CEL variable. It is explanation, not adjudication (the constitution requires cross-project samples before a new metric may enter a gate), and changing the weight fingerprint would invalidate sealed calibrations. It appears in the `check` review line (next to disconnectedness) and in the `diff` cognitive-point shape clause (`singleCallSiteRatioDelta`). **To judge whether one file's share is high, compare it against the project's own distribution/P95 — do not introduce an absolute threshold.**

`nestingDepth` counts only block and function boundaries (`blockTypes`: statement blocks, functions/methods, arrow functions, if/for/while/switch, class, try/catch); expression or object-literal nesting is not counted. Each arrow function in a chained `map`/`flatMap` counts as one level, so a pure data-assembly file can have a high `nestingDepth` without equivalent cognitive burden. A `deep-nesting` threshold is evaluated with `>=` (meeting the threshold triggers); interpret P95 against this definition, and keep a manual exemption judgement for pure data-assembly files.

#### Three ways to read a local-burden WARN (calibrated 2026-09-27, each measured)

- **The rule measures the per-function maximum (`max_func_branch`), so splitting alone clears it**: a measured refactor left the file's total unchanged (`weightedBranchTotal` 13.7 → 13.7) and even raised direct non-local calls (41 → 47), yet the WARN disappeared because `maxFuncBranch` fell 4.0 → 1.3. Clearing the line only means "no single function exceeds the threshold"; it is **not** evidence that the file got simpler. Read it together with the `declaration lines (concept-count proxy)` (`declarationLoc`) and `single-call-site helpers` values printed on the same report line.
- **A condition may be a conjunction** (e.g. `crl_local > 0.45 && exposure > 0.6`): a file that is no longer named is **not** evidence that every component is back inside its threshold — the measured example is `crl_local` below 0.45 while `exposure` stayed at 0.603. To judge whether the file really improved, read its local-burden/exposure pair together.
- **A component may be saturated**: external passthrough enters local burden as `0.15 × min(1, N/P95)`; once it reaches P95 (the report line marks `capped`), lowering that dimension further **cannot** improve this line — that is "no headroom left", not "not good enough yet". In this repository only **35 of 402 production files (8.7%) exceed `exposure > 0.6`**, so the term does discriminate: **do not** conclude the threshold is broken just because a few files sit close to it.
- To re-measure any of these numbers for one file or the whole repository, use the bundled read-only tool (it reuses the gate's own read path): `pnpm measure:structure -- <file...>`, `pnpm measure:structure -- --all --exposure`. When P95 is unavailable it reports `UNAVAILABLE`, never `0`.

A normal `scan` updates observed `P95` only. A sealed calibration epoch remains the denominator for unchanged files. `scan --seal-calibration` is a reviewed team action. Observed/sealed deviation is `CALIBRATION_SHIFT`, report-only. **Enforced populations with fewer than 50 production files are small samples**: gate output adds a caution (sealed/bootstrapped); P95 is unstable there, so treat thresholds as observational and avoid adding BLOCK.

## Retired And Closed-Loop Status (Calibrated 2026-08-15)

- Retired CEL variables: `branch_count`, `crl_state`, `crl_inputs`, `cohesion`, `function_count`, `symbol_scope` - using them in a gate rule is a configuration error.
- `testMetrics` persistence is retired: test governance is read-only and re-collects every run; `TEST_BLOAT` stays a report-only diagnostic behind `openarch test --bloat`, outside governance signals.
- `cohesion` is no longer written into new baseline shards; old shards remain read-compatible.

### The DRY/DAMP boundary for tests (`codeSimilarityRatio` of `TEST_BLOAT`)

A test suite's DRY boundary is the **opposite** of production code, and the tool expresses that boundary so you do not have to re-invent it every time:

- **Assembly / pipeline** (the `@Mock` trio, `@Before` wiring, H2/DDL schema setup, connection and result-reading boilerplate) **should be DRY**: extracting a single source of truth is a clear win.
- **Assertions and measurement protocol** (`assert*`, `verify`, counting and result interpretation) **should be DAMP**: each case must read as a standalone specification; hiding assertions in shared helpers creates implicit coupling, and semantic drift then escapes every unit test.

So `codeSimilarityRatio` **scores only duplication it can prove is assembly**, using the **test-case body range** confirmed by providers (the `test-case-spans` fact domain), and reports four buckets on one line:

| Bucket | Meaning | Scored |
|---|---|---|
| Assembly (outside case bodies) | The block lies entirely outside every recognised test-case body | yes |
| Unclassified | The file had **no recognised test case** (the body boundary does not apply) and the block has calls | yes, but explicitly labelled "not proven assembly boilerplate" |
| Inside a case body | The block intersects a recognised case body (arrange and measurement protocol) | **no** |
| Assertion-bearing duplication | The block contains a recognised assertion/verification call | **no** - extracting it only creates implicit coupling |

The judgment (`assertionRecognition`) covers the JUnit assertion family, the Mockito `verify` family, `@Test(expected=...)`, and same-file/cross-file assertion wrappers. Case bodies come from providers (JUnit uses the method body, TS-based providers the case callback body; neither includes signature or annotation lines). **The body boundary is only applied to files that produced at least one recognised test case** - otherwise "the whole file lies outside every body" would mischarge test-body duplication as extractable assembly, exactly backwards.

**Three boundaries you must read**: case-body evidence `PARTIAL` (some files unrecognised or failed to collect), `files with no recognised test case: N`, and `block-semantics evidence missing: N files` (Go/Rust have no matching syntax). In those cases duplication is scored as unclassified/total volume and labelled as such - it is a **fact boundary, not clean**.

**How to read it**: only look at the buckets once `codeSimilarityRatio` triggers. A high inside-case-body or assertion bucket **requires no action** - the report says so; only a high assembly/unclassified bucket suggests extracting a fixture. The historical defect was exactly that assertion and test-body duplication counted as "should be extracted", pushing agents toward a self-contradictory goal.

### Bloat-factor measurability is decided per language

Of the five factors, `codeSimilarityRatio` and `sizeDispersion` are language-neutral; the other three decide measurability by **language shape**, and report `UNAVAILABLE` with a reason rather than 0 when they cannot be measured:

| factor | measurable languages | unavailable reason elsewhere |
|---|---|---|
| `weakAssertionRatio` | TS family (**officially-sourced `toBeTruthy`/`toBeFalsy` only**; the unsourced `toBeDefined` was dropped on 2026-09-27), Java (`assertNotNull`/`assertTrue`/`assertFalse`) | `language_not_supported_by_pattern` |
| `fixtureBoilerplateRatio` | TS-family shape only (`mkdirSync`/`writeFileSync`/`git` calls + text minhash) | `language_not_supported_by_pattern` |
| `growthRatio` | TS-family path history only | `no_language_matched_history` |

**Comparability boundary (must read)**: the `weakAssertionRatio` threshold 0.03 and the `fixtureBoilerplateRatio` threshold 0.08 both come from a **TS/JS population** calibration; thresholds carry no language dimension (adding one is the "new P95/threshold dimension" red line and needs an owner decision). So when a Java value triggers, the only confirmed fact is "the weak-assertion share is v" - it does not by itself prove the value is excessive, and recalibrating against a Java population is the project owner's call. Measured reference: JUnit's own suite gives `v = 0.169`, i.e. that threshold is far exceeded on Java - evidence that it needs its own calibration, not a conclusion.

**Java `fixtureBoilerplateRatio` remains unimplemented** (recorded deliberately): the TS criterion depends on an `fs`/`git` call vocabulary plus language-specific call-text normalisation; Java has no comparable fixed vocabulary, and inventing one would dress a convention up as a fact. Revisit condition: a real Java project needs fixture-boilerplate governance and the owner confirms the vocabulary.

## Exploratory Policy Calibration

When `rules_warn`/`rules_block` is empty, the baseline scope is current, and complete `P95`/Top-3 facts exist, `review` shows the observed reference. These values are inputs to project calibration, not OpenArch defaults or portable cross-project thresholds. The Agent must state tolerance, sample scope, false-positive handling, and the rescan plan, then ask the owner to choose one minimal `WARN`, two independent `WARN`s, or a documented deferral. Do not auto-create a `BLOCK` on the first round; without complete P95, remain `UNAVAILABLE` rather than guessing from one file or another project.

Use `structural_policies` to calibrate separate populations in multi-language or multi-service repositories. Each profile declares its language set and may narrow to explicit project-relative `scope.include`/`scope.exclude`; language and scope intersect. Never infer a service from its directory, package, or import graph. Every production file must match exactly one profile: zero or multiple matches are `UNAVAILABLE`, never a reason to borrow a neighbouring language, service, or default threshold. After adding a scope, run a complete scan to establish its independent P95 before choosing observe or enforce.

## Change Diagnosis `D_MR`

`D_MR` is a production-only, report-only change diagnosis using the same `P95` family. It reports burden regression and improvement separately; they do not offset. `Δα_struct` explains only, while `connectedness` is excluded. A new file has only after facts; missing comparable before facts must remain `UNAVAILABLE`. Tests and auxiliary files never participate.

Use `D_MR` to inspect responsibility splitting, control flow, nesting, size, or orchestration in changed files. Without independent calibration evidence, never add it to the gate or `I_push`.
