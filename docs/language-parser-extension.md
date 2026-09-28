# Language Parser Extension Template

**Scope**: OpenArch product contributors working in this repository. This is not an extension API for a packaged OpenArch executable.

## Purpose

Use this template whenever OpenArch adds a language or parser strategy. A language extension is not complete when it can merely parse a file: it must register one language authority, expose only explainable cross-language facts, and prove its grammar mapping with fixtures.

This template deliberately has no project paths, framework assumptions, or threshold values. A language may support fewer facts than another language; unsupported facts must remain unavailable.

## Released Parser Coverage

The released parser registry currently supports TypeScript, JavaScript, Go, Rust, Python, and Java. Python uses the same shared structural, declaration, and import-fact contracts as the other Tree-sitter strategies. Its resolver proves only static imports that map to a project-root module or a relative module (`module.py` or `module/__init__.py`). Java resolves only explicit imports that map to a conventional Maven/Gradle `src/main/java` or `src/test/java` source file. Python dynamic imports, `sys.path` mutation, import hooks, namespace packages, plus Java classpath lookup, wildcard imports, generated sources, reflection, and unresolved or external modules remain `resolvedPath: null`.

Parser support does not imply a test-governance provider or a symbol/data-flow authority analyzer for that language. The released static-import authority templates are a narrow exception: they reuse parser-confirmed raw import sources through the engine-owned `static-imports.v1` stage, so no template carries grammar node names. Dynamic imports, parser failures and syntax not represented by a strategy remain unavailable; broader authority claims still need their own evidence contracts and calibration.

## 1. Register One Language Authority

Update the single language registry with the language id, extensions, parser kind, and evidence-backed project indicators. Reuse that registry from source discovery, parser routing, scan filtering, manual diff filtering, and init detection. If no registered language is detected, initialization must preserve an empty analysis scope and report unavailable; it must not choose a default language. Keep module semantics in the language resolver rather than encoding suffix guesses in the registry. Do not add parallel extension lists or source globs in commands, providers, or scripts.

## 2. Implement the Parser Strategy

The strategy owns grammar node names and language syntax extraction. A language module resolver owns the project/module semantics that turn raw specifiers into local paths. Together they produce `FileAst` through `ParserService` and preserve these boundaries:

| Fact | Contract |
|---|---|
| Imports | Extract the raw specifier from the parser, then resolve a local module only when the language/module resolver can prove it using its project semantics (for example TS compiler options or `go.mod`); external or unresolved imports are `resolvedPath: null`, never guessed paths. |
| Functions | Extract named function facts used by structural analysis without treating nested functions as outer-function complexity. |
| Control flow | Map language grammar nodes to the shared weighted facts: ordinary control flow `1.0`, guard/case `0.3`. The guard **judgment** is shared (`StructuralFacts.createGuardClauseDetector`); a strategy declares only which node types are jumps (`jumpTypes`) and which are containers to descend through (`containerTypes`). Equivalent spellings of one guard — braced and brace-less — must score identically; a strategy must never implement its own guard predicate. |
| Top-level flow | Stop at function boundaries so entry-point dispatch is not mixed with function complexity. |
| Queries | Return captures with text, 1-based lines, and exact source offsets. Consumers that assign nested syntax to an owner must use offsets, not lines. |
| Exported functions | Populate `exportedSymbols` only for narrow, parser-confirmed local exported functions. Values, classes, re-exports, overloads, and unsupported visibility rules remain absent rather than guessed. |
| Invocation bindings | When the language can prove a typed parameter or same-scope local/field alias at a method call, emit the shared `invocation-bindings.v1` receiver/method/target fact. Strategies must supply AST-node semantics to `InvocationBindingFacts.ts`; they must not re-parse `node.text` with regex. Do not infer cross-function object flow, collections, dynamic dispatch, reflection, macros, or unresolved aliases; those remain unavailable. |

Core connects facts but must not carry grammar node names. Framework providers recognise test syntax but must not implement a second language parser.

For Tree-sitter strategies, reuse `adapter/parser/TreeSitterRuntime.ts` for grammar lifecycle, `StructuralFacts.ts` for traversal, weighted branch aggregation, nested-function ownership, comment collection, and function facts, `ImportExtraction.ts` for raw import traversal, and `ModuleResolver.ts` for resolved import assembly. The strategy supplies named syntax/structural adapters for grammar-specific node classification, jump/container declarations, function naming, call targets, and raw import extraction. Do not copy metric traversals, import traversals, or filesystem/module-resolution rules into each language strategy: a shared metric-contract or resolver-contract change must have one implementation and cross-language fixtures. The guard predicate is the worked example of why this matters: 0.1.5 kept five copies, two of which were exact mirrors of each other — TS/JS recognised only the brace-less form and Java only the braced form — so `maxFuncBranch` disagreed with itself across languages and adding braces to one line changed the score.

## 3. Define Unavailable Before Adding a Fact

For every proposed fact, state all three outcomes before implementation:

1. A proven value.
2. A proven empty set.
3. Unavailable because the language/parser cannot establish it.

Never serialize unavailable as `0`, `[]`, a fallback path, or an inferred symbol. Version storage contracts instead of changing the meaning of existing values.

## 4. Fixture Matrix

Add positive and negative fixtures at the parser boundary. The minimum matrix is:

| Scenario | Required assertion |
|---|---|
| Local import and external import | local target resolves; external stays null. For TS/JS, include a NodeNext-style relative runtime `.js` specifier whose scanned source target is `.ts`, a real `.js` target that wins exact resolution, and a missing `.js` target that stays null. |
| Function with nested lambda/function | outer metrics do not absorb nested ownership. |
| Normal branch, guard, switch/case | weighted total, max-function, and top-level facts use the documented language mapping. For a guard, assert that the braced and brace-less spellings of the same clause produce the **same** weighted value, and that a guard is cheaper than an ordinary branch. |
| Exported and non-exported function | only supported local exported functions appear in `exportedSymbols`. |
| Query capture | exact offset and line positions are present. |
| Invocation binding | typed receiver and supported local alias resolve to the same canonical target; dynamic or unresolved flow produces no binding fact. |
| Unsupported syntax/fact | parser succeeds where possible and leaves the fact unavailable; it does not invent a value. |

If a test framework provider will consume the language, add provider fixtures separately. Provider fixtures must show both a valid recognised test and a boundary case such as nested callbacks or unresolved imports.

### 4.1 Regular expressions are only for bounded short text

Text matching with regular expressions is acceptable **only where both the input length and the structure are provably bounded**. Anything that reads a whole file, a whole manifest, or an unbounded user document must go through a structural path (parse tree, single-pass bounded scanner, or reuse of an already-parsed fact) instead.

- Bounded and acceptable: a query predicate over a single capture (`#match?` on one identifier), a single line already split out of a bounded buffer, a fixed-format token.
- Not acceptable: matching a whole source file, a whole `go.mod`/`Cargo.toml`, or a whole Markdown document. Those are long, adversarial inputs where a regex is both fragile (nested quoting/comments defeat it) and costly (backtracking).
- When a structural path cannot be used, prove the bound and encode it explicitly (maximum line count, depth limit), and fail closed — "unparsed / undecidable" is a valid outcome, never a guessed value.
- Prefer reusing an existing parse result over a second textual pass. A regex that merely restates a fact the parser already produced is a second, drifting authority.

## 5. Integrate Through Existing Boundaries

Update the language registry, `ParserFactory`, source discovery, analysis scope, and parser tests as one change. Do not encode the language's directory layout, package manager, test naming convention, or layer weights in OpenArch defaults.

For test S2 associations, explicit imports belong in versioned `TestMetrics`; import-external dependencies belong to the `implicit-deps` staged engine and `implicit-deps.yml`. They share a fact-then-link method but not storage, confidence semantics, or policy consumers.

## 6. Verify And Document

Run language-specific parser/provider fixtures, `pnpm lint`, `pnpm test`, `openarch check --staged` with truthful contract/implementation change kinds, and `openarch check`. Update the language capability reference shipped with the Skill and this template when the generic contract changes. Do not distribute parser implementation instructions in the packaged plugin; its Skill must only describe the released CLI's public extension points.

Do not add a language-specific gate, CRL input, or S2 confidence upgrade merely because the parser can collect a raw fact. Calibrate the fact first.
