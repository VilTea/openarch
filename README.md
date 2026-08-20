<div align="center">

# OpenArch

**Give your AI agents an anti-corruption line of defense — that they can rebuild, cheaply, as the code drifts.**

A local-first governance framework for AI-assisted teams: it accepts that software corrosion is inevitable, and gives every agent a lightweight, continuously-rebuildable defense line — grounded in information theory, verified by deterministic local evidence, and carried as a playbook your agents actually read.

`openarch` — one command, five-language symbol-level analysis, 28 built-in script entries (12 anti-patterns · 9 test-governance · 5 starters · 1 implicit-deps · 1 config), zero-LSP gate, fully reproducible end to end.

*Simplified Chinese: [README.zh-CN.md](./README.zh-CN.md)*

</div>

---

## The premise: corrosion is not a bug you fix. It is a force you resist.

Every change looks reasonable in isolation. Complexity accumulates silently. A rule that made sense in March is bypassed by June. This is not a quality lapse — it is **entropy doing its job**. Left alone, any system drifts toward disorder.

Most tools treat this as a one-time problem: run a linter, set a quality gate, and be done. That is why they fail. The gate ages, the rule set ossifies, and the next agent writes around it.

OpenArch starts from the opposite premise — **corrosion is unavoidable, so the defense line must be cheap to rebuild**. Not a wall you build once, but a trench line you can dig, lose, and re-dig anywhere, at any time, with whatever forces you have. The cost of re-establishing governance must be low enough that you never have an excuse not to.

### What "anti-corruption" means here

| Corrosion you will meet | How OpenArch resists it |
|--------------------------|--------------------------|
| **Local burden grows** — a function quietly becomes a god-function | CRL local-burden metric, language-level P95 calibration (no hardcoded thresholds) |
| **Authority boundaries leak** — a module reaches into another's protected paths | Authority rules enforced by static-import analysis, fail-closed |
| **Boilerplate multiplies** — tests copy the same setup eight times | TEST_BLOAT with minhash similarity detection |
| **Impact is invisible** — a signature change breaks consumers you never saw | I_push / C_push change-impact with symbol-level consumer confirmation |
| **Experience is lost** — the same trap resets the same agent every cycle | Reusable rule scripts + a Skill playbook the agent reads before working |

## The theory: state is the baseline, change is the signal

> “Information is that which reduces uncertainty.” — Claude Shannon, *The Mathematical Theory of Communication* (1948)

The current state of a system tells you where you stand; **the way it is changing** tells you what to watch. OpenArch runs on two complementary rails — state snapshots and change deltas:

- **State is the baseline, change is the signal** — `openarch scan` builds the state baseline (CRL, structure, TEST_BLOAT); `openarch check` measures the change against that baseline (I_push, C_push, D_MR, calibration shifts). Judgments are made on change — but change needs a state reference to be meaningful. The two are complementary, not mutually exclusive.
- **Log compression** — raw counts are compressed through logarithms into signal strength, so no single extreme value dominates a judgment.
- **Preserve uncertainty** — facts are classified by identity, source, scope, and lifecycle; `PARTIAL` / `UNAVAILABLE` are factual boundaries, never dressed up as clean. A rule that lacks evidence stays unavailable — it does not fake a pass.
- **Zero hardcoded thresholds** — every threshold is calibrated against the project's own observed distribution (language-level P95), so the defense line fits the project instead of a universal assumption.

## A defense line agents can re-dig — because it is a playbook

OpenArch does not hand your agent a rule list. It installs a **Skill** — a methodology the agent actually reads — into the agent's own workspace:

```bash
openarch init --agent claude   # claude | codex | cursor | opencode | reasonix
```

The Skill carries the working discipline: *run `openarch context` before judging, follow the routing table, treat `check` output as a full signal surface, and never confuse "no verdict" with "clean."* It is the same methodology across every agent platform — one playbook, five harnesses.

This is the difference between **gates** (a wall that ages) and **capability** (a trench line the agent can rebuild when the front moves). When the code drifts, you do not wait for a new gate — the agent already knows how to re-establish the line.

## Deterministic, local, auditable — by design

Mainstream AI-code tools are cloud review bots: your code leaves the building, and the verdict comes from an LLM you cannot inspect. OpenArch is the opposite by construction:

- **No LLM in the gate.** Structural analysis, change impact, and rule execution are deterministic — compiler/LSP providers and tree-sitter, running locally, reproducible on any machine.
- **Local-first.** Toolchain paths are machine facts, never committed. `openarch scan` rebuilds every artifact from source.
- **Fail-closed.** When evidence is missing or ambiguous, the answer is `PARTIAL` / `UNAVAILABLE`, never a confident guess.
- **Symbol-level, five languages.** TypeScript (compiler provider, exact), Python (pyright), Rust (rust-analyzer), Java (jdtls), Go (static upper bound, fail-closed) — down to confirmed consumers.

## Quick Start

> Agents and users: follow [INSTALL.md](./INSTALL.md) to build the bun-compiled binary and install the `openarch` CLI. Chinese: [INSTALL.zh-CN.md](./INSTALL.zh-CN.md).

After the CLI is installed:

```bash
# Initialize a governed project (--agent optional: claude / codex / cursor / opencode / reasonix)
openarch init --agent claude
openarch context

# Establish the first baseline
openarch scan
openarch review

# Verify after each change
openarch check --worktree --report    # during implementation
openarch check --staged --report      # after staging
```

## Involving AI Agents

### Project-scoped Skill (recommended)

```bash
openarch init --agent claude
```

Writes to `.claude/skills/openarch/`, auto-matches project language (`zh`/`en`), updates atomically. Supports `claude`, `codex`, `cursor`, `opencode`, `reasonix`.

### User-scoped Skill (plugin)

The [OpenArch Agent Plugin](./packages/openarch-plugin/README.md) provides static host-discoverable Skills (`openarch-zh`/`openarch-en`) and a user-scoped installer (`openarch-agent-install`).

### Agent workflow discipline (embedded in the Skill)

- Run `openarch context` first, then choose scan / review / check / rules / docs
- `check` is a **full signal surface**: Verdict is not completion; read WARNs, TEST_BLOAT, findings, and signals even on PASS
- `PARTIAL` / `UNAVAILABLE` are factual boundaries — handle them or record them, never fake clean

## Command Line

```text
Public commands:  init · context · contract · scan · review · check · rules · docs · toolchains · test · update
Advanced commands: coordination · lsp · calibration · anti-patterns
```

Per-command usage: `openarch <command> --help`.

- `review --evolution` turns real Git commit history into a report-only coordination-surface investigation; `rules discover` feeds the implicit-dependency graph that makes change impact reproducible without an LSP.
- `rules facts` is a self-describing script-fact registry: filter by `--domain/--query/--status`, see which installed scripts consume each fact, and use `--unused` as a zero-consumer CI hint.
- `check --worktree|--staged --report --verbose --tests --full --record-config` is the full verification surface; `--semantic` adds compiler/LSP consumer evidence on top of the deterministic static graph, and `--output-mode <summary|detail|full>` shapes agent-facing report depth.

## Test Governance

`openarch test` is an independent report layer, not a quality score:

- Six reference adapters: **Vitest** and **node:test** (TS/JS), **Go testing**, **Rust Cargo test**, **Java JUnit**, **Python pytest** — plus Cargo/Maven/Gradle/pytest/node:test runners for actual command evidence (`node --test` is built into Node, no extra dependency).
- Provider coverage is fail-closed: `candidates / handled / missingBaseline / failed` per provider, test-illusion findings for assertions that look like assertions but are not, and S2 static module→test associations.
- `openarch test [--list] [--bloat] [--json]`: no active provider shows adapter suggestions per detected language — suggestions only, never auto-enabled.

## Machine Contracts & Plugins

External integrations (such as the [DSH plugin](./packages/openarch-plugin/README.md)) consume versioned JSON contracts instead of parsing `.openarch` internals:

- Every payload self-identifies with a top-level `schema`: `context --json` (`context-json-v1`), `test --json` (`test-governance-json-v1`), `test --list --json` (`test-governance-provider-list-v1`), `rules facts --json` (`rules-facts-json-v1` — the self-describing script-fact registry with per-fact consumer observability), and `docs check --json` (`docs-check-json-v1` — document-store check evidence: similarity candidates, unfilled templates, and `docs decide` dispositions).
- `openarch contract --json` is the machine-contract catalog: breaking changes bump the version; plugins fail closed on unknown versions instead of guessing.
- `context --json` readiness entries carry `kind: enforcing | advisory | optional` — a missing code hook is a real ⚠ (commits skip the gate); `coordination-service: not_configured` is the normal optional state, not a failure.
- `update --json` is read-only remote-release awareness; it never auto-installs.

## Languages & Toolchains

| Language | Symbol-level dimension |
|----------|------------------------|
| TypeScript | Compiler provider (precise) |
| Python | pyright, cross-file reliable |
| Rust | rust-analyzer + crate:: extraction |
| Java | jdtls forwarding daemon |
| Go | static upper bound + file-heavy fallback (fail-closed) |

External toolchains are **machine facts**: `openarch toolchains` to inspect, `openarch init --toolchains user` to configure.

Symbol-level `complete` is a calibrated boundary, not a universal claim: TypeScript within governed tsconfig projects; Rust single-crate without `build.rs`/workspace/macro invocation/path attributes/cfg; Go single-module without `go.work`/build constraints/generated code; Java standard Maven layout without modules/deps/reflection; Python within pyright-resolvable scope. Outside those boundaries the report stays `PARTIAL` and keeps the facts it did collect — never downgraded to a fake zero.

Direct semantic relations (`semantic-relations.v1`) span TypeScript (compiler provider) and Python/Go/Java/Rust (LSP providers, relation families `extends` / `implements` / `embeds` / `instantiates`); `openarch lsp start java|go` keeps the jdtls/gopls forwarding daemon warm for larger workspaces.

## Project Structure

```text
packages/core/            Core: scanning, metrics, anti-pattern engine, symbol-level analysis, script runtime
packages/cli/             CLI command surface
packages/openarch-plugin/ Host Skill assets + user-scoped Skill installer
services/coordination/    Go coordination service (task/lease/evidence, optional remote)
docs/                     User-facing docs (installation, command references, contracts)
```

## Documentation

- [Install Guide (source build, reproducible)](./INSTALL.md)
- [Chinese Install Guide](./INSTALL.zh-CN.md)
- [Coordination CLI](./docs/coordination-cli.md)
- [LSP warm-up & multi-harness hooks](./docs/lsp-daemon-hooks.md)
- [Extension Script Contract](./docs/extension-script-contract.md)

## License

[MIT](./LICENSE)

Copyright (c) 2026 OpenArch Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
