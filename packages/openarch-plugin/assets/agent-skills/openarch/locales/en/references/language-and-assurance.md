# Language And Assurance

> “实践、认识、再实践、再认识，这种形式，循环往复以至无穷。” — Mao Zedong, *On Practice* (1937)

Read this page before relying on a parser, tests, compiler, `LSP`, `SCIP`, or an external semantic capability.

## Portable Boundary

Shared product capabilities are metrics, baselines, provider and script contracts, project source discovery, and syntax parsing, not a language-directory convention. The released product parses TypeScript/JavaScript, Go, Rust, Python, and Java. Syntax support does not imply complete import resolution, test governance, authority analysis, symbol use, or security coverage.

Language ids map one-to-one to extensions: `typescript` (.ts/.tsx/.mts/.cts), `javascript` (.js/.jsx/.mjs/.cjs), `vue` (.vue), `go`, `rust`, `python`, `java`. **vue is an independent language**: configuring `"vue"` in `languages` matches only `.vue` files and is not contained in `javascript` — a project with both `.vue` and `.js/.jsx` files must configure both (vue `<script>` blocks are analyzed with js/ts semantics, but extension matching is independent).

Python has calibrated static-root, relative-module, and single-root implicit-namespace package mapping; dynamic imports, `sys.path`, import hooks, multi-root namespaces, or explicit Pyright execution environments remain `PARTIAL` or `UNAVAILABLE`. Execution-environment configuration means the preferred `pyrightconfig.json`, or `[tool.pyright]` in `pyproject.toml` when no JSON file exists; matching `executionEnvironments` or `extraPaths` retains reference facts but cannot establish complete scope. Java proves only conventional Maven/Gradle roots and explicit imports; classpath, wildcard imports, generated source, and reflection remain `UNAVAILABLE`. Read other boundaries from current command output and provider coverage, never from runtime installation alone.

## External Semantic Providers

`openarch toolchains` only finds global, bundled, `PATH`, or platform tools; it neither installs nor starts them. Put routine machine paths in the user `toolchains.yml`, and checkout-specific overrides in `.openarch/toolchains.local.yml`; the command prints both locations. Precedence is one-tool `OPENARCH_<TOOL_ID>_PATH` (CI/temporary override) -> checkout-local config -> user config -> `PATH`/platform discovery. `OPENARCH_TOOLCHAINS_FILE` may redirect the one user configuration file but does not replace per-tool paths. A missing, malformed, or project-local executable is unavailable. The checkout-local file may hold absolute paths, but must not enter Git or project policy configuration. Discovering an executable is only a prerequisite fact, never proof of complete semantic analysis. Provider reports must identify the provider, evidence source, and independent declaration/reference coverage; only complete scope may support an isolated-use conclusion, and public or partial facts cannot lower `I_push` or change a gate.

`file_kinds` is one project classification fact reused by every consumer: `observed` retains all source observation, `production-governance` alone enters production metrics, graphs, and compiler/LSP symbol use, `test-governance` alone enters test governance, and `change-evidence` includes production plus test. Never label source `auxiliary` merely to obtain `complete` coverage; read its responsibility first, and classify only project-evidenced non-product files such as pure test-runner configuration, verification input, or release artifacts. After changing `file_kinds`, run `openarch scan` to rebuild the baseline, then `openarch check --record-config` to audit the configuration change.

### Analysis Path

Tree-sitter static syntax analysis remains the available fallback for `I_push`, declaration-level diffs, and the structural graph. It computes a structural propagation upper bound from parsable source and static imports; it does not prove exact symbol consumers. When a non-TypeScript project needs symbol references, direct-consumer evidence, or later semantic facts, run `openarch toolchains`, configure the language LSP in the matching user or checkout-local toolchain file, then run `openarch check --worktree --semantic --report` against the **unstaged worktree**.

Java symbol evidence usually depends on the jdtls forwarding daemon: when `openarch toolchains` shows `jdtls` unavailable but `javac` available, `--semantic` still fails closed and emits no C_push. Projects that need Java symbol evidence should run `openarch lsp start` first to warm up jdtls (see `docs/lsp-daemon-hooks.md` for keeping it resident), then run `openarch check --worktree --semantic --report`; the first cold index can take tens of seconds and becomes much faster once the daemon is warm.

The report names the active path for every language. `STATIC parser fallback` means that LSP was not requested or is unavailable; `LSP`/`COMPILER` names the provider, declaration coverage, reference coverage, `scope`, and risks. Only `scope=repository` can claim a complete population; `scope=demand` selects declarations for the current change and both coverage dimensions are necessarily `PARTIAL`. Declaration families state the comparable fact granularity, and later conclusions may consume only families shared and calibrated across languages. Proven references appear separately in the verification plan to help an Agent inspect specific consumers; they do not yet change `I_push`, CRL, D_MR, the baseline, or the gate. `PARTIAL` retains proven facts but never proves zero references or a complete consumer set. `--staged --semantic` is rejected because LSP reads the worktree rather than the Git index: collect worktree evidence first, then stage and run static `check --staged` against that snapshot.

### Reading Semantic Results

Symbol-use results declare declaration coverage and repository-reference coverage separately. A zero reference is an isolated candidate only for an internal declaration when both are `COMPLETE`; public surface, `UNKNOWN`, `PARTIAL`, and `UNAVAILABLE` never establish a zero-reference conclusion. TypeScript/JavaScript direct static functions, classes, named contract members, static property indexing, and object-destructured properties may produce these facts. A supported project-reference consumer resolves back to its governed source declaration. Implementations behind interface or inheritance contracts, object escape, and dynamic dispatch remain `UNKNOWN`. Do not treat the result as a call graph, runtime data flow, or proof about external consumers.

Python, Go, Rust, and Java semantic results are likewise bounded by the provider, scope, and coverage reported for this run. Python `__name__` data-model hooks are runtime-dispatched and are not internal zero-reference candidates; dynamic imports, reflection, macros, conditional compilation, generated source, alias plugins, or an unsupported workspace shape keep the result `PARTIAL` or `UNAVAILABLE`. Complete gopls references apply only to one `go.mod` root without `go.work`, build constraints, or generated Go source, after gopls has published diagnostics for every opened governed source. Complete Java references apply only to a conventional single Maven root without modules, external dependencies, or detected reflection. Complete Rust references apply only to a single-root `Cargo.toml` crate without `build.rs`, a workspace, macro invocation, or conditional compilation, after Rust Analyzer has published diagnostics for every opened governed source. Without that readiness evidence or in any excluded shape, Go and Rust remain `PARTIAL`. Do not infer clean from a tool being installed or from an empty finding in any other shape.

## Test Providers

Registered providers (query with `openarch test --list`) and their static scope:

| provider id | framework/language | assertion recognition |
|---|---|---|
| `typescript-vitest` | Vitest (TS/JS) | `expect(...)`/`assert(...)` and same-file wrappers whose body contains an assertion |
| `node-test` | node:test | `assert.*` and same-file wrappers whose body contains an assertion |
| `java-junit` | JUnit 4/5 (Java) | `assert*` method family and same-file wrapper methods whose body contains an assertion |
| `go-testing` | Go testing | `t.Error/Fatal` etc. (no universal assertion library; no missing-assertion policy) |
| `rust-testing` | Rust `#[test]` | `assert*!` macros; delegated calls count as verification intent |
| `python-pytest` | pytest | `assert` statements and file-level wrapper functions whose body contains an assert |

`python-pytest` recognizes only conventional test functions or methods, AST-confirmed assertions, and a narrow set of direct markers or calls. Java JUnit recognizes conventional annotations and assertions. Go and Rust likewise have explicit static scope only. Dynamic marks, aliases, plugins, runtime conditions, parameterization, and framework extensions remain `PARTIAL`; runners report actual commands separately from provider facts.

## Semantic Relation Facts

`semantic-relations.v1` is a report-only fact that a project script may request on demand. It currently describes only directly provable `extends`, `implements`, explicit types, and `new` construction, with source, coverage, and evidence. It is not a call graph, transitive dependency graph, dependency injection, reflection, or dynamic dispatch, and it does not enter `I_push`, CRL, D_MR, baseline, or gate. A script may consume it only after declaring `requires`; incomplete results remain `PARTIAL` or `UNAVAILABLE`.
