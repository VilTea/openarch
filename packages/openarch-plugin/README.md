# OpenArch Agent Plugin

Install `@openarch/cli` for project governance. This package has two roles:

- It exposes `openarch-zh` and `openarch-en` as static host-discoverable Skills.
- Its `openarch-agent-install` command installs a user-scoped Skill only.

Both packages ship as GitHub Release assets (`@openarch/core` / `@openarch/cli` / `@openarch/plugin` tarballs) and can be built locally with `pnpm release:local`. **They are not published to the npm registry**, so install from a tarball path or the native binary rather than by package name.

For a governed project, always install or refresh the project Skill through the CLI:

```bash
npm install --save-dev /path/to/openarch-cli-<version>.tgz
npx openarch init --agent claude
```

The CLI uses `.openarch/config.yml: presentation.locale` to choose `zh` or `en`. It is the only supported project-scope installation path. A temporary CLI `--lang` option changes output only and cannot replace the project Skill language.

For an optional user-scoped Skill:

```bash
npm install --global /path/to/openarch-plugin-<version>.tgz
openarch-agent-install --target claude --locale en
```

`--locale` is optional and defaults from the host locale. Supported targets are `claude`, `codex`, `cursor`, `opencode`, `reasonix`, and `dsh` (DeepSeek Harness) — one target per host, with no default: pass the host you actually use. User-scope roots honour `CODEX_HOME`, `REASONIX_HOME`, and `DSH_HOME`. The standalone installer deliberately has no project scope; use `openarch init --agent <target>` for each project. Per-host commands and destinations are tabulated in [INSTALL.md](./INSTALL.md).

**DSH integration uses the bundle / dashboard plugin** (static package): install `@openarch/plugin` as a DSH profile bundle to enable the dashboard and the governance-state data channel. This path requires the packaged client bundle (`lib/client.js`), which is built by `pnpm --dir packages/openarch-plugin build:client` or automatically by `prepack` before `pnpm pack`. The DSH agent preset (`--preset`) has been removed because it was not stable. See [`dsh/README.md`](./dsh/README.md) for details.

For source or offline use, create local tarballs, install the CLI tarball into the governed project, then run the same CLI initialization:

```bash
pnpm release:local
npm install --save-dev /absolute/path/to/openarch-cli-<version>.tgz
npx openarch init --agent claude
```

Install the optional code hook after initialization with `openarch init --install-hook`. Use `openarch context` to expose read-only project facts, `openarch check --worktree --report` during implementation, and `openarch check --staged --report` after staging.
