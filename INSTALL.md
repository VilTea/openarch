# Install OpenArch (Source Build)

For Chinese instructions, read [INSTALL.zh-CN.md](./INSTALL.zh-CN.md).

OpenArch installs a persistent `openarch` CLI for project governance. A project-scoped
Skill is installed by the CLI so it uses that project's `presentation.locale`.

This document covers the **source-build path only**: clone the repository, build the
bun-compiled binary, install it, and initialize a governed project. npm-registry
distribution is deferred (see `docs/plans/2026-08-08-typescript7-migration.md` for
release-形态 tracking).

## Prerequisites

- Node.js 20 or later
- `pnpm` 9.x (the repository pins `packageManager: pnpm@9.0.0`; `corepack enable`
  activates it from `package.json`)
- Git

Run project commands from the repository OpenArch will govern.

## 1. Build the Binary

From an OpenArch source checkout (requires [bun](https://bun.sh), Node.js 20+,
and `pnpm` 9.x via `corepack enable`):

```bash
corepack enable
pnpm install
pnpm release:binary
```

`pnpm release:binary` compiles the CLI into a single executable with `bun build
--compile` (bundling runtime dependencies — including the TypeScript compiler
API used by symbol-level analysis — into the binary, so no `node_modules`
dependency tree is needed at install time). Output lands in
`artifacts/binary/openarch-<platform>-<arch>/`:

- `openarch(.exe)` — the compiled executable
- `resources/` — packaged tree-sitter WASM grammars, script assets, and Skills

The script probes the built binary in throwaway projects: `--help`, `rules
skeleton`, per-language `scan` (typescript/go/rust/python), and Skill install
for `zh`/`en` agents. It verifies the binary loads packaged grammars and assets
before you commit to installing it.

## 2. Install the Binary

Keep the built directory together (`openarch(.exe)` beside its `resources/`).
For a persistent command shared by local repositories and Agent sessions:

```bash
pnpm release:local-command
```

This builds (if needed), probes, and atomically installs the executable with
its resources under `%LOCALAPPDATA%\OpenArch\bin`, then adds that directory to
the user `PATH`. Open a new terminal or Agent session after the first install,
then verify with:

```bash
openarch --version
```

For a manual install, copy `artifacts/binary/openarch-<platform>-<arch>/`
anywhere (keeping the executable beside `resources/`) and add it to `PATH`.

## 3. Initialize a Governed Project

```bash
# replace claude with your agent: claude | codex | cursor | opencode | reasonix | dsh
openarch init --agent claude
openarch context
```

`--agent` accepts `claude`, `codex`, `cursor`, `opencode`, `reasonix`, or `dsh`. It writes only the
selected project-local directory (for example `.claude/skills/openarch/`), reads
`.openarch/config.yml: presentation.locale`, and installs the matching `zh` or `en`
Skill tree. Updates atomically replace the entire previous OpenArch Skill directory,
removing retired files. Missing or invalid configuration falls back to `en`; `--lang`
changes CLI output only, never the installed Skill.

## 3.1 Agent Skill Installation (agents: read this)

This document is written for agents. After the CLI is installed, **you** install
the OpenArch Skill into your own working environment so the governance
methodology is available in this project:

1. **Install the Skill for your harness** — run `init` with your target so the
   Skill lands in your project-local skills directory:

   | harness | command | Skill location |
   |---------|---------|----------------|
   | Claude | `openarch init --agent claude` | `.claude/skills/openarch/` |
   | Codex | `openarch init --agent codex` | `.codex/skills/openarch/` |
   | Cursor | `openarch init --agent cursor` | `.cursor/skills/openarch/` |
   | OpenCode | `openarch init --agent opencode` | `.opencode/skills/openarch/` |
   | Reasonix | `openarch init --agent reasonix` | `.reasonix/skills/openarch/` |
   | DSH | `openarch init --agent dsh` | `.dsh/skills/openarch/` |

   The command writes only the selected project-local directory, reads
   `presentation.locale`, and installs the matching `zh` or `en` Skill tree.
   Rerun it after an OpenArch upgrade to refresh the Skill (retired files are
   removed atomically).

2. **Verify the Skill is present** — check your harness's skills directory
   exists and contains `SKILL.md` before relying on it:

   ```bash
   ls .claude/skills/openarch/SKILL.md    # replace with your target path
   ```

   If it is missing, run the matching `init --agent` command again and read any
   error output.

3. **Follow the Skill during work** — the installed Skill is your playbook:
   read it before governance work, run `openarch context` to establish project
   facts, then choose `scan` / `review` / `check` / `rules` / `docs` per the
   routing table. `check` output is a full signal surface — read WARNs,
   TEST_BLOAT, anti-pattern findings, and signals even on Verdict PASS;
   `PARTIAL`/`UNAVAILABLE` are factual boundaries, not clean.

For another compatible agent, provide its project-relative skills parent explicitly:

```bash
openarch init --skill-dir .my-agent/skills
```

Install a code-repository pre-commit hook after initialization:

```bash
openarch init --install-hook
```

## 4. Governance Persistence

`governance.persistence` in `.openarch/config.yml` is the only authority for whether
runtime governance artifacts belong in Git. New projects default to `tracked`. For a
personal repository:

```bash
openarch init --mode personal --install-hook
```

This writes `governance.persistence: local` and adds only an OpenArch-owned
`.openarch/` block to `.git/info/exclude`. The hook still seals semantic evidence and
evaluates the configured gate, but does not stage generated baseline, history, or
audit artifacts. It never changes DocumentStore mode or removes already tracked paths.

Use `openarch init --mode team --install-hook`, or set `governance.persistence:
tracked`, for the reviewed team workflow. Local runtime state can be recreated with
`openarch scan`.

## 5. External Toolchains

External compilers and language servers are machine facts, not project dependencies.
Inspect the tools required by configured project languages with:

```bash
openarch toolchains
```

Create a user-wide configuration, then add only the external absolute executable
paths required by the languages you use:

```bash
openarch init --toolchains user
```

For a checkout-specific override, use `openarch init --toolchains project`. It creates
`.openarch/toolchains.local.yml` and adds that file only to Git's local exclude, so
machine paths are not committed. CI can retain `OPENARCH_<TOOL_ID>_PATH`; it overrides
both files. The installed OpenArch Skill reads the matching Python, Go, Rust, or Java
configuration reference when discovery is unavailable.

## 6. Verify

After initialization, run `openarch context` for read-only project facts. During
implementation use `openarch check --worktree --report`; after staging use
`openarch check --staged --report`. The published command surface is `openarch init`,
`openarch context`, `openarch contract`, `openarch scan`, `openarch review`, `openarch check`,
`openarch rules`, `openarch docs`, `openarch test`, `openarch toolchains`, and `openarch update`
(`openarch coordination`,
`openarch lsp`, `openarch calibration`, and `openarch anti-patterns` are
advanced-visible). `openarch test --list` lists the registered test-governance
providers (ids used in `test_governance.providers`); bare `openarch test` runs
the test-governance evaluation. `openarch contract [--json]` prints the
machine-contract catalog for external plugins (contract id/version/status); read it
at plugin startup so unknown contract versions degrade to text or unavailable
instead of being parsed as an older version. `openarch update` is read-only: it compares the installed
version against the latest release and prints update steps; it never
auto-installs. Re-run `openarch init --agent <harness>` after upgrading to
refresh the installed Skill tree.
