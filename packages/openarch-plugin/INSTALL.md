# Installing the OpenArch Skill

One page for every supported host. The project Skill is always installed by the **CLI**; the
standalone `openarch-agent-install` only installs a **user-scoped** Skill.

There is **no default target**: `--agent` / `--target` is required everywhere. OpenArch never guesses
which agent you are, because guessing would silently write into one host's directory and the report
would then describe a Skill tree you never asked for.

Both packages ship as GitHub Release assets (tarballs for `@openarch/core` / `@openarch/cli` /
`@openarch/plugin`) and can be built locally with `pnpm release:local`. **They are not published to
the npm registry**, so install from a tarball path or the native binary rather than by package name.

## Project-scoped (per repository, the governance path)

```bash
npm install --save-dev /path/to/openarch-cli-<version>.tgz
npx openarch init --agent <target>
```

Reads `.openarch/config.yml: presentation.locale` to choose the whole `zh` / `en` Skill tree and
replaces the target directory atomically (retired files are cleared). A temporary CLI `--lang`
option changes output only and cannot replace the project Skill language.

| Host | Command | Skill location |
|------|---------|----------------|
| Claude | `openarch init --agent claude` | `.claude/skills/openarch/` |
| Codex | `openarch init --agent codex` | `.codex/skills/openarch/` |
| Cursor | `openarch init --agent cursor` | `.cursor/skills/openarch/` |
| OpenCode | `openarch init --agent opencode` | `.opencode/skills/openarch/` |
| Reasonix | `openarch init --agent reasonix` | `.reasonix/skills/openarch/` |
| DeepSeek Harness | `openarch init --agent dsh` | `.dsh/skills/openarch/` |
| Other compatible agent | `openarch init --skill-dir .my-agent/skills` | project-relative directory you name |

## User-scoped (optional, shared across projects)

```bash
npm install --global /path/to/openarch-plugin-<version>.tgz
openarch-agent-install --target <target> [--locale <zh|en>]
```

`--locale` is optional and defaults from the host locale. The installer has **no project scope** on
purpose — use `openarch init --agent <target>` inside each governed project.

| Host | Command | Skill location |
|------|---------|----------------|
| Claude | `openarch-agent-install --target claude` | `~/.claude/skills/openarch` |
| Codex | `openarch-agent-install --target codex` | `${CODEX_HOME:-~/.codex}/skills/openarch` |
| Cursor | `openarch-agent-install --target cursor` | `~/.cursor/skills/openarch` |
| OpenCode | `openarch-agent-install --target opencode` | `~/.config/opencode/skills/openarch` |
| Reasonix | `openarch-agent-install --target reasonix` | `${REASONIX_HOME:-~/.reasonix}/skills/openarch` |
| DeepSeek Harness | `openarch-agent-install --target dsh` | `${DSH_HOME:-~/.dsh}/skills/openarch` |

The plugin also exposes the static `openarch-zh` and `openarch-en` Skills for hosts that discover
plugin skills directly. Use the locale that matches the session; project governance remains the
CLI's responsibility.

## After installing

Run `openarch context` to expose read-only project facts, then use `scan`, `review`, `check`,
`rules`, or `docs` according to the task. Install the code hook separately with
`openarch init --install-hook`. When CLI behavior diverges from what the Skill describes, run
`openarch update --json` (read-only), rebuild, then re-run `openarch init --agent <target>` to
refresh the Skill atomically.
